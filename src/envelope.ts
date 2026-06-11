import { SoapFault } from './fault.js';
import type { SoapHeaderValue, SoapOperationRequest, SoapValue, SoapVersion } from './types.js';
import {
    elementChildren,
    firstElementChildByLocalName,
    getAttributeByLocalName,
    getAttributeNS,
    localName,
    namespaceURI,
    normalizeSoapAction,
    parseXmlDocument,
    SOAP_ENCODING_NS,
    SOAP11_ENVELOPE_NS,
    SOAP12_ENVELOPE_NS,
    stripPrefix,
    textContent,
    XML_SCHEMA_INSTANCE_NS,
    type XmlDocument,
    type XmlElement,
} from './xml.js';

interface ParseOptions {
    inferTypes: boolean;
    soapAction?: string;
}

export interface ParsedSoapEnvelopeForDispatch extends SoapOperationRequest {
    operationElement: XmlElement;
    parameterElements: XmlElement[];
    parameterElementsByName: Map<string, XmlElement[]>;
}

const NIL_TRUE_VALUES = new Set(['true', '1']);
const INTEGER_TYPES = new Set([
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
const FLOAT_TYPES = new Set(['float', 'double', 'decimal']);
const INTEGER_PATTERN = /^[+-]?(0|[1-9]\d*)$/;
const FLOAT_PATTERN = /^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][+-]?\d+)?$/;

export function parseSoapEnvelope(xml: string, options: ParseOptions): SoapOperationRequest {
    return parseSoapEnvelopeForDispatch(xml, options);
}

export function parseSoapEnvelopeForDispatch(xml: string, options: ParseOptions): ParsedSoapEnvelopeForDispatch {
    let document: XmlDocument;
    try {
        document = parseXmlDocument(xml);
    } catch (error) {
        throw new SoapFault('Client', error instanceof Error ? error.message : 'Malformed XML', { status: 500 });
    }

    const envelope = document.documentElement;
    if (localName(envelope) !== 'Envelope') {
        throw new SoapFault('VersionMismatch', 'SOAP Envelope element is missing', { status: 500 });
    }

    const soapVersion = soapVersionFromNamespace(namespaceURI(envelope));
    const body = firstElementChildByLocalName(envelope, 'Body');
    if (!body) {
        throw new SoapFault('Client', 'SOAP Body element is missing', { soapVersion, status: 500 });
    }

    const bodyChildren = elementChildren(body);
    const operationElement = bodyChildren.find((child) => localName(child) !== 'Fault');
    if (!operationElement) {
        throw new SoapFault('Client', 'SOAP Body does not contain an operation element', { soapVersion, status: 500 });
    }

    const headerElement = firstElementChildByLocalName(envelope, 'Header');
    const headers = headerElement ? parseHeaderBlocks(headerElement, soapVersion, options) : [];
    const parameterElements = elementChildren(operationElement);
    const parameters: SoapValue[] = [];
    const namedParameters: Record<string, SoapValue> = {};
    const parameterElementsByName = new Map<string, XmlElement[]>();

    for (const child of parameterElements) {
        const value = deserializeElement(child, options);
        const name = localName(child);
        parameters.push(value);
        addNamedValue(namedParameters, name, value);
        const existing = parameterElementsByName.get(name);
        if (existing) {
            existing.push(child);
        } else {
            parameterElementsByName.set(name, [child]);
        }
    }

    return {
        operationName: localName(operationElement),
        namespaceURI: namespaceURI(operationElement),
        parameters,
        namedParameters,
        headers,
        soapVersion,
        operationElement,
        parameterElements,
        parameterElementsByName,
    };
}

export function deserializeElement(element: XmlElement, options: Pick<ParseOptions, 'inferTypes'>): SoapValue {
    const nil = getAttributeByLocalName(element, 'nil') ?? getAttributeNS(element, XML_SCHEMA_INSTANCE_NS, 'nil');
    if (nil && NIL_TRUE_VALUES.has(nil.trim())) {
        return null;
    }

    const children = elementChildren(element);
    if (children.length > 0) {
        if (isArrayElement(element, children)) {
            return children.map((child) => deserializeElement(child, options));
        }

        const value: Record<string, SoapValue> = {};
        for (const child of children) {
            addNamedValue(value, localName(child), deserializeElement(child, options));
        }
        return value;
    }

    return parseScalarValue(textContent(element), getXsiType(element), options.inferTypes);
}

function parseHeaderBlocks(header: XmlElement, soapVersion: SoapVersion, options: ParseOptions): SoapHeaderValue[] {
    return elementChildren(header).map((child) => {
        const mustUnderstand = parseMustUnderstand(child, soapVersion);
        const actor = getAttributeByLocalName(child, soapVersion === '1.2' ? 'role' : 'actor');
        const parsed: SoapHeaderValue = {
            name: localName(child),
            namespaceURI: namespaceURI(child),
            value: deserializeElement(child, options),
            mustUnderstand,
        };
        if (actor !== undefined) {
            parsed.actor = actor;
        }
        return parsed;
    });
}

function parseMustUnderstand(element: XmlElement, soapVersion: SoapVersion): boolean {
    const value = getAttributeByLocalName(element, 'mustUnderstand');
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    if (soapVersion === '1.1') {
        return normalized === '1' || normalized === 'true';
    }
    return normalized === 'true' || normalized === '1';
}

function soapVersionFromNamespace(value: string | null): SoapVersion {
    if (value === SOAP11_ENVELOPE_NS) {
        return '1.1';
    }
    if (value === SOAP12_ENVELOPE_NS) {
        return '1.2';
    }
    throw new SoapFault('VersionMismatch', `Unsupported SOAP Envelope namespace: ${value ?? '(none)'}`, {
        status: 500,
    });
}

function isArrayElement(element: XmlElement, children: XmlElement[]): boolean {
    const type = stripPrefix(getXsiType(element));
    const arrayType = getAttributeByLocalName(element, 'arrayType');
    if (type === 'Array' || arrayType || namespaceURI(element) === SOAP_ENCODING_NS) {
        return true;
    }

    if (children.length === 0) {
        return false;
    }

    const names = children.map((child) => localName(child));
    const first = names[0];
    return first === 'item' && names.every((name) => name === first);
}

function getXsiType(element: XmlElement): string | undefined {
    return getAttributeNS(element, XML_SCHEMA_INSTANCE_NS, 'type') ?? getAttributeByLocalName(element, 'type');
}

function parseScalarValue(value: string, typeName: string | undefined, inferTypes: boolean): SoapValue {
    const localType = stripPrefix(typeName);
    const trimmed = value.trim();

    if (localType && INTEGER_TYPES.has(localType)) {
        if (!INTEGER_PATTERN.test(trimmed)) {
            throw encodingViolationFault();
        }
        return Number.parseInt(trimmed, 10);
    }

    if (localType && FLOAT_TYPES.has(localType)) {
        if (!FLOAT_PATTERN.test(trimmed)) {
            throw encodingViolationFault();
        }
        return Number.parseFloat(trimmed);
    }

    if (localType === 'boolean' || localType === 'bool') {
        const normalized = trimmed.toLowerCase();
        if (normalized === 'true' || trimmed === '1') {
            return true;
        }
        if (normalized === 'false' || trimmed === '0') {
            return false;
        }
        throw encodingViolationFault();
    }

    if (!inferTypes) {
        return value;
    }

    if (/^(true|false)$/i.test(trimmed)) {
        return trimmed.toLowerCase() === 'true';
    }
    if (/^-?(0|[1-9]\d*)$/.test(trimmed)) {
        return Number.parseInt(trimmed, 10);
    }
    if (/^-?(0|[1-9]\d*)\.\d+(e[+-]?\d+)?$/i.test(trimmed) || /^-?(0|[1-9]\d*)e[+-]?\d+$/i.test(trimmed)) {
        return Number.parseFloat(trimmed);
    }

    return value;
}

function encodingViolationFault(): SoapFault {
    return new SoapFault('Server', 'SOAP-ERROR: Encoding: Violation of encoding rules', { status: 500 });
}

function addNamedValue(target: Record<string, SoapValue>, name: string, value: SoapValue): void {
    const existing = target[name];
    if (existing === undefined) {
        target[name] = value;
        return;
    }

    if (Array.isArray(existing)) {
        existing.push(value);
        return;
    }

    target[name] = [existing, value];
}

export function soapActionFromHeaders(headers: Headers): string | undefined {
    return normalizeSoapAction(headers.get('SOAPAction') ?? headers.get('soapaction'));
}
