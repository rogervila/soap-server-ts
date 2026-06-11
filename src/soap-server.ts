import {
    deserializeElement,
    type ParsedSoapEnvelopeForDispatch,
    parseSoapEnvelopeForDispatch,
    soapActionFromHeaders,
} from './envelope.js';
import { isSoapFault, SoapFault, toSoapFault, UnsupportedSoapFeatureError } from './fault.js';
import { contentTypeForSoapVersion, serializeSoapFault, serializeSoapResponse } from './serializer.js';
import type {
    OutgoingSoapHeader,
    SoapClassConstructor,
    SoapHandler,
    SoapHandlerMap,
    SoapOperationRequest,
    SoapRequestContext,
    SoapServerOptions,
    SoapValue,
    SoapVersion,
    WsdlMetadata,
    WsdlOperation,
} from './types.js';
import { loadWsdlXml, parseWsdl } from './wsdl.js';
import { validateWsdlRequestWithXsd } from './xsd.js';

export const SOAP_FUNCTIONS_ALL = -1;

const DEFAULT_CONTENT_TYPES = ['text/xml', 'application/xml', 'application/soap+xml'];
const INTEGER_WSDL_TYPES = new Set([
    'int',
    'integer',
    'long',
    'short',
    'byte',
    'nonNegativeInteger',
    'nonPositiveInteger',
    'positiveInteger',
    'negativeInteger',
    'unsignedInt',
    'unsignedLong',
    'unsignedShort',
    'unsignedByte',
]);
const FLOAT_WSDL_TYPES = new Set(['float', 'double', 'decimal']);
const INTEGER_PATTERN = /^[+-]?(0|[1-9]\d*)$/;
const FLOAT_PATTERN = /^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][+-]?\d+)?$/;

interface NormalizedOptions extends SoapServerOptions {
    soapVersion: SoapVersion;
    encoding: string;
    inferTypes: boolean;
    exposeStackTraces: boolean;
    returnWsdlOnGet: boolean;
    cacheWsdl: boolean;
    strictXsdValidation: boolean;
    faultHttpStatus: number;
    contentTypes: string[];
}

interface ClassRegistration {
    ctor: SoapClassConstructor;
    args: unknown[];
}

interface DispatchTarget {
    handler: SoapHandler;
    thisArg?: unknown;
}

export class SoapServer {
    private readonly wsdlSource: string | null;
    private readonly options: NormalizedOptions;
    private readonly functions = new Map<string, SoapHandler>();
    private readonly outgoingHeaders: OutgoingSoapHeader[] = [];
    private objectTarget: object | undefined;
    private classTarget: ClassRegistration | undefined;
    private wsdlMetadata: WsdlMetadata | undefined;
    private wsdlLoading: Promise<WsdlMetadata | undefined> | undefined;
    private lastResponse: string | undefined;

    constructor(wsdl: string | null = null, options: SoapServerOptions = {}) {
        this.wsdlSource = wsdl;
        this.options = {
            ...options,
            soapVersion: options.soapVersion ?? '1.1',
            encoding: options.encoding ?? 'UTF-8',
            inferTypes: options.inferTypes ?? true,
            exposeStackTraces: options.exposeStackTraces ?? false,
            returnWsdlOnGet: options.returnWsdlOnGet ?? true,
            cacheWsdl: options.cacheWsdl ?? true,
            strictXsdValidation: options.strictXsdValidation ?? false,
            faultHttpStatus: options.faultHttpStatus ?? 500,
            contentTypes: options.contentTypes ?? DEFAULT_CONTENT_TYPES,
        };
    }

    addFunction(name: string, handler: SoapHandler): this;
    addFunction(name: string): this;
    addFunction(functions: SoapHandlerMap): this;
    addFunction(functions: string[]): this;
    addFunction(functions: typeof SOAP_FUNCTIONS_ALL): this;
    addFunction(
        functions: string | string[] | SoapHandlerMap | typeof SOAP_FUNCTIONS_ALL,
        handler?: SoapHandler,
    ): this {
        if (typeof functions === 'string') {
            if (handler) {
                this.functions.set(functions, handler);
                return this;
            }
            const globalHandler = (globalThis as Record<string, unknown>)[functions];
            if (typeof globalHandler !== 'function') {
                throw new UnsupportedSoapFeatureError(`addFunction('${functions}') without an explicit handler`);
            }
            this.functions.set(functions, globalHandler as SoapHandler);
            return this;
        }

        if (Array.isArray(functions)) {
            for (const functionName of functions) {
                this.addFunction(functionName);
            }
            return this;
        }

        if (functions === SOAP_FUNCTIONS_ALL) {
            throw new UnsupportedSoapFeatureError('SOAP_FUNCTIONS_ALL global function registration');
        }

        for (const [functionName, functionHandler] of Object.entries(functions)) {
            if (typeof functionHandler !== 'function') {
                throw new TypeError(`SOAP handler for ${functionName} must be a function`);
            }
            this.functions.set(functionName, functionHandler);
        }

        return this;
    }

    setClass<T extends object>(ctor: SoapClassConstructor<T>, ...args: unknown[]): this {
        this.classTarget = { ctor, args };
        this.objectTarget = undefined;
        return this;
    }

    setObject(target: object): this {
        this.objectTarget = target;
        this.classTarget = undefined;
        return this;
    }

    setPersistence(mode: 'request'): this {
        if (mode !== 'request') {
            throw new UnsupportedSoapFeatureError('persistent SoapServer object state in serverless runtimes');
        }
        return this;
    }

    addSoapHeader(name: string, value: unknown, options: Omit<OutgoingSoapHeader, 'name' | 'value'> = {}): this {
        this.outgoingHeaders.push({ name, value, ...options });
        return this;
    }

    getFunctions(): string[] {
        const names = new Set(this.functions.keys());
        if (this.objectTarget) {
            for (const name of methodNames(this.objectTarget)) {
                names.add(name);
            }
        }
        if (this.classTarget) {
            for (const name of methodNames(this.classTarget.ctor.prototype)) {
                names.add(name);
            }
        }
        return [...names].sort();
    }

    fault(code: string, message: string, actor?: string, detail?: unknown, name?: string): never {
        const options: { actor?: string; detail?: unknown; name?: string; status: number } = {
            status: this.options.faultHttpStatus,
        };
        if (actor !== undefined) {
            options.actor = actor;
        }
        if (detail !== undefined) {
            options.detail = detail;
        }
        if (name !== undefined) {
            options.name = name;
        }
        throw new SoapFault(code, message, options);
    }

    __getLastResponse(): string | undefined {
        return this.lastResponse;
    }

    async handle(request: Request): Promise<Response> {
        if (request.method === 'GET') {
            return this.handleGet(request);
        }

        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', {
                status: 405,
                headers: { Allow: 'GET, POST' },
            });
        }

        const requestSoapVersion =
            this.soapVersionFromContentType(request.headers.get('content-type')) ?? this.options.soapVersion;
        if (!this.isSupportedContentType(request.headers.get('content-type'))) {
            return this.faultResponse(
                new SoapFault(
                    'Client',
                    `Unsupported SOAP Content-Type: ${request.headers.get('content-type') ?? '(none)'}`,
                    {
                        status: 415,
                        soapVersion: requestSoapVersion,
                    },
                ),
                requestSoapVersion,
            );
        }

        try {
            const wsdl = await this.getWsdlMetadata(request);
            const soapAction = soapActionFromHeaders(request.headers);
            const parseOptions: { inferTypes: boolean; soapAction?: string } = { inferTypes: this.options.inferTypes };
            if (soapAction !== undefined) {
                parseOptions.soapAction = soapAction;
            }
            const parsed = parseSoapEnvelopeForDispatch(await request.text(), parseOptions);
            const operation = await this.applyWsdl(parsed, wsdl, soapAction);
            const context = this.createContext(request, parsed, operation, soapAction);
            await this.handleHeaders(context);
            const result = await this.dispatch(operation.name, parsed.parameters, context);

            if (isSoapFault(result)) {
                return this.faultResponse(result, parsed.soapVersion);
            }

            const resultName = operation.outputParts[0]?.name ?? 'return';
            const responseOptions = {
                operationName: operation.name,
                resultName,
                soapVersion: parsed.soapVersion,
                value: result,
                headers: this.outgoingHeaders,
            };
            const namespaceURI = wsdl?.targetNamespace ?? this.options.uri;
            const responseXml = serializeSoapResponse(
                namespaceURI === undefined ? responseOptions : { ...responseOptions, namespaceURI },
            );
            this.lastResponse = responseXml;
            return new Response(responseXml, {
                status: 200,
                headers: { 'content-type': contentTypeForSoapVersion(parsed.soapVersion) },
            });
        } catch (error) {
            const fault = toSoapFault(error, {
                exposeStackTraces: this.options.exposeStackTraces,
                soapVersion: requestSoapVersion,
            });
            return this.faultResponse(fault, fault.soapVersion ?? requestSoapVersion);
        }
    }

    async handleXml(xml: string, init: { url?: string; headers?: HeadersInit } = {}): Promise<string> {
        const request = new Request(init.url ?? 'https://soap-server-ts.local/soap', {
            method: 'POST',
            headers: {
                'content-type': 'text/xml; charset=utf-8',
                ...headersToRecord(init.headers),
            },
            body: xml,
        });
        const response = await this.handle(request);
        return response.text();
    }

    private async handleGet(request: Request): Promise<Response> {
        if (!this.options.returnWsdlOnGet) {
            return new Response('Not Found', { status: 404 });
        }

        const wsdl = await loadWsdlXml(this.wsdlSource, this.options, request);
        if (!wsdl) {
            return new Response('Not Found', { status: 404 });
        }

        return new Response(wsdl, {
            status: 200,
            headers: { 'content-type': 'text/xml; charset=utf-8' },
        });
    }

    private async getWsdlMetadata(request: Request): Promise<WsdlMetadata | undefined> {
        if (this.options.cacheWsdl && this.wsdlMetadata) {
            return this.wsdlMetadata;
        }

        if (this.options.cacheWsdl && this.wsdlLoading) {
            return this.wsdlLoading;
        }

        const load = async (): Promise<WsdlMetadata | undefined> => {
            const xml = await loadWsdlXml(this.wsdlSource, this.options, request);
            if (!xml) {
                return undefined;
            }
            const metadata = parseWsdl(xml);
            if (this.options.cacheWsdl) {
                this.wsdlMetadata = metadata;
            }
            return metadata;
        };

        const loading = load();
        if (this.options.cacheWsdl) {
            this.wsdlLoading = loading;
        }
        try {
            return await loading;
        } finally {
            if (this.options.cacheWsdl) {
                this.wsdlLoading = undefined;
            }
        }
    }

    private async applyWsdl(
        parsed: ParsedSoapEnvelopeForDispatch,
        wsdl: WsdlMetadata | undefined,
        soapAction: string | undefined,
    ): Promise<WsdlOperation> {
        const actionOperation = soapAction ? wsdl?.operationsBySoapAction.get(soapAction) : undefined;
        const operation = wsdl?.operations.get(parsed.operationName) ?? actionOperation;

        if (wsdl && !operation) {
            throw new SoapFault('Client', `Function "${parsed.operationName}" is not a valid method for this service`, {
                status: 500,
                soapVersion: parsed.soapVersion,
            });
        }

        const effectiveOperation = operation ?? {
            name: parsed.operationName,
            inputParts: [],
            outputParts: [],
        };

        if (operation && operation.inputParts.length > 0) {
            parsed.parameters = operation.inputParts.map((part, index) =>
                mapWsdlPartValue(part, parsed, index, this.options.inferTypes),
            );
            parsed.namedParameters = Object.fromEntries(
                operation.inputParts.map((part, index) => [part.name, parsed.parameters[index] ?? null]),
            );
        }

        if (wsdl && operation) {
            await validateWsdlRequestWithXsd(wsdl, operation, parsed, {
                strict: this.options.strictXsdValidation,
            });
        }

        return effectiveOperation;
    }

    private createContext(
        request: Request,
        parsed: SoapOperationRequest,
        operation: WsdlOperation,
        soapAction: string | undefined,
    ): SoapRequestContext {
        const context: SoapRequestContext = {
            request,
            operationName: operation.name,
            soapVersion: parsed.soapVersion,
            headers: parsed.headers,
            namedParameters: parsed.namedParameters,
            wsdlOperation: operation,
        };
        if (soapAction !== undefined) {
            context.soapAction = soapAction;
        }
        return context;
    }

    private async handleHeaders(context: SoapRequestContext): Promise<void> {
        for (const header of context.headers) {
            const target = this.resolveTarget(header.name);
            if (target) {
                await invokeTarget(target, [header.value], context);
                continue;
            }

            if (header.mustUnderstand) {
                throw new SoapFault('MustUnderstand', `SOAP header "${header.name}" was not understood`, {
                    soapVersion: context.soapVersion,
                    status: 500,
                });
            }
        }
    }

    private async dispatch(
        operationName: string,
        parameters: SoapValue[],
        context: SoapRequestContext,
    ): Promise<unknown> {
        const target = this.resolveTarget(operationName);
        if (!target) {
            throw new SoapFault('Client', `Function "${operationName}" is not a valid method for this service`, {
                soapVersion: context.soapVersion,
                status: 500,
            });
        }
        return invokeTarget(target, parameters, context);
    }

    private resolveTarget(name: string): DispatchTarget | undefined {
        const functionTarget = this.functions.get(name);
        if (functionTarget) {
            return { handler: functionTarget };
        }

        if (this.objectTarget) {
            const candidate = (this.objectTarget as Record<string, unknown>)[name];
            if (typeof candidate === 'function') {
                return { handler: candidate as SoapHandler, thisArg: this.objectTarget };
            }
        }

        if (this.classTarget) {
            const instance = new this.classTarget.ctor(...this.classTarget.args);
            const candidate = (instance as Record<string, unknown>)[name];
            if (typeof candidate === 'function') {
                return { handler: candidate as SoapHandler, thisArg: instance };
            }
        }

        return undefined;
    }

    private faultResponse(fault: SoapFault, version: SoapVersion): Response {
        const responseXml = serializeSoapFault(fault, version);
        this.lastResponse = responseXml;
        return new Response(responseXml, {
            status: fault.status,
            headers: { 'content-type': contentTypeForSoapVersion(version) },
        });
    }

    private isSupportedContentType(contentType: string | null): boolean {
        if (!contentType) {
            return true;
        }
        const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
        return mediaType ? this.options.contentTypes.includes(mediaType) : true;
    }

    private soapVersionFromContentType(contentType: string | null): SoapVersion | undefined {
        const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
        return mediaType === 'application/soap+xml' ? '1.2' : undefined;
    }
}

function mapWsdlPartValue(
    part: { name: string; type?: string; elementQName?: { localName: string; namespaceURI?: string } },
    parsed: ParsedSoapEnvelopeForDispatch,
    index: number,
    inferTypes: boolean,
): SoapValue {
    const element = part.elementQName ? findWsdlElementPart(parsed, part.elementQName, index) : undefined;
    const value = element
        ? deserializeElement(element, { inferTypes })
        : (parsed.namedParameters[part.name] ?? parsed.parameters[index] ?? null);

    return validateWsdlPartValue(part, value);
}

function findWsdlElementPart(
    parsed: ParsedSoapEnvelopeForDispatch,
    qname: { localName: string; namespaceURI?: string },
    index: number,
) {
    if (matchesWsdlQName(parsed.operationElement, qname)) {
        return parsed.operationElement;
    }
    return (
        parsed.parameterElementsByName.get(qname.localName)?.find((element) => matchesWsdlQName(element, qname)) ??
        parsed.parameterElements[index]
    );
}

function matchesWsdlQName(
    element: { localName: string; namespaceURI: string | null },
    qname: { localName: string; namespaceURI?: string },
) {
    return (
        element.localName === qname.localName &&
        (qname.namespaceURI === undefined || element.namespaceURI === qname.namespaceURI)
    );
}

function validateWsdlPartValue(part: { name: string; type?: string }, value: SoapValue): SoapValue {
    if (value === null) {
        return null;
    }

    const localType = stripTypePrefix(part.type);
    if (!localType) {
        return value;
    }

    if (INTEGER_WSDL_TYPES.has(localType)) {
        return validateWsdlInteger(part.name, value);
    }

    if (FLOAT_WSDL_TYPES.has(localType)) {
        return validateWsdlFloat(part.name, value);
    }

    if (localType === 'boolean' || localType === 'bool') {
        return validateWsdlBoolean(part.name, value);
    }

    if (localType === 'string') {
        return typeof value === 'object' ? invalidWsdlValue(part.name) : String(value);
    }

    return value;
}

function validateWsdlInteger(name: string, value: SoapValue): number {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && INTEGER_PATTERN.test(value.trim())) {
        return Number.parseInt(value.trim(), 10);
    }
    return invalidWsdlValue(name);
}

function validateWsdlFloat(name: string, value: SoapValue): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && FLOAT_PATTERN.test(value.trim())) {
        return Number.parseFloat(value.trim());
    }
    return invalidWsdlValue(name);
}

function validateWsdlBoolean(name: string, value: SoapValue): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const normalized = trimmed.toLowerCase();
        if (normalized === 'true' || trimmed === '1') {
            return true;
        }
        if (normalized === 'false' || trimmed === '0') {
            return false;
        }
    }
    return invalidWsdlValue(name);
}

function invalidWsdlValue(name: string): never {
    throw new SoapFault('Server', 'SOAP-ERROR: Encoding: Violation of encoding rules', {
        detail: { parameter: name },
        status: 500,
    });
}

function stripTypePrefix(typeName: string | undefined): string | undefined {
    if (!typeName) {
        return undefined;
    }
    const index = typeName.indexOf(':');
    return index === -1 ? typeName : typeName.slice(index + 1);
}

export function createSoapFetchHandler(server: SoapServer): (request: Request) => Promise<Response> {
    return (request: Request) => server.handle(request);
}

async function invokeTarget(
    target: DispatchTarget,
    parameters: unknown[],
    context: SoapRequestContext,
): Promise<unknown> {
    const args = target.handler.length > parameters.length ? [...parameters, context] : parameters;
    return target.handler.apply(target.thisArg, args);
}

function methodNames(target: object): string[] {
    const names = new Set<string>();
    let current: object | null = target;

    while (current && current !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(current)) {
            if (name === 'constructor') {
                continue;
            }
            const descriptor = Object.getOwnPropertyDescriptor(current, name);
            if (typeof descriptor?.value === 'function') {
                names.add(name);
            }
        }
        current = Object.getPrototypeOf(current) as object | null;
    }

    return [...names];
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) {
        return {};
    }
    return Object.fromEntries(new Headers(headers).entries());
}
