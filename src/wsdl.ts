import { SoapFault } from './fault.js';
import type {
    SoapServerOptions,
    WsdlLoaderContext,
    WsdlMetadata,
    WsdlOperation,
    WsdlPart,
    WsdlQName,
    WsdlSchema,
    WsdlSchemaComponent,
} from './types.js';
import {
    descendantElements,
    elementChildren,
    firstElementChildByLocalName,
    getAttribute,
    localName,
    normalizeSoapAction,
    parseXmlDocument,
    resolveQName,
    serializeXmlElement,
    stripPrefix,
    XML_SCHEMA_NS,
    type XmlElement,
    type XmlQName,
} from './xml.js';

export function isInlineWsdl(source: string): boolean {
    return /^\s*</.test(source);
}

export async function loadWsdlXml(
    source: string | null,
    options: SoapServerOptions,
    request?: Request,
): Promise<string | undefined> {
    if (options.wsdlXml) {
        return options.wsdlXml;
    }

    if (source && isInlineWsdl(source)) {
        return source;
    }

    const url = options.wsdlUrl ?? (source && !isInlineWsdl(source) ? source : undefined);
    if (!url) {
        return undefined;
    }

    if (options.wsdlLoader) {
        const context: WsdlLoaderContext = { url };
        if (request !== undefined) {
            context.request = request;
        }
        return options.wsdlLoader(context);
    }

    if (typeof fetch !== 'function') {
        throw new SoapFault('Server', 'WSDL URL loading requires a Fetch API implementation or wsdlLoader option', {
            status: 500,
        });
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new SoapFault('Server', `Failed to load WSDL from ${url}: HTTP ${response.status}`, { status: 500 });
    }
    return response.text();
}

export function parseWsdl(xml: string): WsdlMetadata {
    const document = parseXmlDocument(xml);
    const definitions = document.documentElement;
    if (localName(definitions) !== 'definitions') {
        throw new SoapFault('Client', 'WSDL 1.1 document must have a definitions root element', { status: 500 });
    }

    const targetNamespace = getAttribute(definitions, 'targetNamespace');
    const schemas = parseSchemas(definitions);
    const messages = parseMessages(definitions);
    const portTypeOperations = parsePortTypeOperations(definitions, messages);
    const operations = parseBindingOperations(definitions, portTypeOperations);
    const operationsBySoapAction = new Map<string, WsdlOperation>();

    for (const operation of operations.values()) {
        if (operation.soapAction) {
            operationsBySoapAction.set(operation.soapAction, operation);
        }
    }

    const metadata: WsdlMetadata = {
        schemas,
        operations,
        operationsBySoapAction,
        rawXml: xml,
    };
    if (targetNamespace !== undefined) {
        metadata.targetNamespace = targetNamespace;
    }
    const serviceLocation = parseServiceLocation(definitions);
    if (serviceLocation !== undefined) {
        metadata.serviceLocation = serviceLocation;
    }
    return metadata;
}

function parseMessages(definitions: XmlElement): Map<string, WsdlPart[]> {
    const messages = new Map<string, WsdlPart[]>();

    for (const message of elementChildren(definitions).filter((child) => localName(child) === 'message')) {
        const name = getAttribute(message, 'name');
        if (!name) {
            continue;
        }

        const parts = elementChildren(message)
            .filter((child) => localName(child) === 'part')
            .map((part): WsdlPart => {
                const parsed: WsdlPart = { name: getAttribute(part, 'name') ?? 'parameters' };
                const type = getAttribute(part, 'type');
                const element = getAttribute(part, 'element');
                if (type !== undefined) {
                    parsed.type = type;
                    const typeQName = toWsdlQName(resolveQName(part, type));
                    if (typeQName !== undefined) {
                        parsed.typeQName = typeQName;
                    }
                }
                if (element !== undefined) {
                    parsed.element = element;
                    const elementQName = toWsdlQName(resolveQName(part, element));
                    if (elementQName !== undefined) {
                        parsed.elementQName = elementQName;
                    }
                }
                return parsed;
            });

        messages.set(name, parts);
    }

    return messages;
}

function parseSchemas(definitions: XmlElement): WsdlSchema[] {
    const schemas: WsdlSchema[] = [];

    for (const types of elementChildren(definitions).filter((child) => localName(child) === 'types')) {
        for (const schema of elementChildren(types).filter(isXmlSchemaElement)) {
            const targetNamespace = getAttribute(schema, 'targetNamespace');
            const parsed: WsdlSchema = {
                xml: serializeXmlElement(schema, { includeInheritedNamespaces: true }),
                elements: new Map<string, WsdlSchemaComponent>(),
                types: new Map<string, WsdlSchemaComponent>(),
            };
            if (targetNamespace !== undefined) {
                parsed.targetNamespace = targetNamespace;
            }

            for (const child of elementChildren(schema)) {
                const name = getAttribute(child, 'name');
                if (!name) {
                    continue;
                }

                const component: WsdlSchemaComponent = {
                    name,
                    xml: serializeXmlElement(child, { includeInheritedNamespaces: true }),
                };
                if (targetNamespace !== undefined) {
                    component.namespaceURI = targetNamespace;
                }

                const key = schemaComponentKey(targetNamespace, name);
                if (localName(child) === 'element') {
                    parsed.elements.set(key, component);
                } else if (localName(child) === 'complexType' || localName(child) === 'simpleType') {
                    parsed.types.set(key, component);
                }
            }

            schemas.push(parsed);
        }
    }

    return schemas;
}

function isXmlSchemaElement(element: XmlElement): boolean {
    return localName(element) === 'schema' && (element.namespaceURI === XML_SCHEMA_NS || element.namespaceURI === null);
}

function toWsdlQName(qname: XmlQName | undefined): WsdlQName | undefined {
    if (!qname) {
        return undefined;
    }
    const parsed: WsdlQName = {
        rawName: qname.rawName,
        localName: qname.localName,
    };
    if (qname.namespaceURI !== null) {
        parsed.namespaceURI = qname.namespaceURI;
    }
    return parsed;
}

function schemaComponentKey(namespaceURI: string | undefined, name: string): string {
    return `${namespaceURI ?? ''}\u0000${name}`;
}

function parsePortTypeOperations(
    definitions: XmlElement,
    messages: Map<string, WsdlPart[]>,
): Map<string, WsdlOperation> {
    const operations = new Map<string, WsdlOperation>();

    for (const portType of elementChildren(definitions).filter((child) => localName(child) === 'portType')) {
        for (const operationElement of elementChildren(portType).filter((child) => localName(child) === 'operation')) {
            const name = getAttribute(operationElement, 'name');
            if (!name) {
                continue;
            }

            const inputMessage = stripPrefix(
                getAttribute(firstElementChildByLocalName(operationElement, 'input') ?? operationElement, 'message'),
            );
            const outputMessage = stripPrefix(
                getAttribute(firstElementChildByLocalName(operationElement, 'output') ?? operationElement, 'message'),
            );
            const operation: WsdlOperation = {
                name,
                inputParts: inputMessage ? (messages.get(inputMessage) ?? []) : [],
                outputParts: outputMessage ? (messages.get(outputMessage) ?? []) : [],
            };
            if (inputMessage !== undefined) {
                operation.inputMessage = inputMessage;
            }
            if (outputMessage !== undefined) {
                operation.outputMessage = outputMessage;
            }
            operations.set(name, operation);
        }
    }

    return operations;
}

function parseBindingOperations(
    definitions: XmlElement,
    portTypeOperations: Map<string, WsdlOperation>,
): Map<string, WsdlOperation> {
    const operations = new Map(portTypeOperations);

    for (const binding of elementChildren(definitions).filter((child) => localName(child) === 'binding')) {
        const bindingStyle = firstElementChildByLocalName(binding, 'binding');
        const defaultStyle = normalizeStyle(getAttribute(bindingStyle ?? binding, 'style'));

        for (const operationElement of elementChildren(binding).filter((child) => localName(child) === 'operation')) {
            const name = getAttribute(operationElement, 'name');
            if (!name) {
                continue;
            }

            const base = operations.get(name) ?? { name, inputParts: [], outputParts: [] };
            const soapOperation = firstElementChildByLocalName(operationElement, 'operation');
            const body = descendantElements(operationElement, 'body')[0];
            const merged: WsdlOperation = {
                name: base.name,
                inputParts: base.inputParts,
                outputParts: base.outputParts,
            };
            if (base.inputMessage !== undefined) {
                merged.inputMessage = base.inputMessage;
            }
            if (base.outputMessage !== undefined) {
                merged.outputMessage = base.outputMessage;
            }
            const soapAction =
                normalizeSoapAction(getAttribute(soapOperation ?? operationElement, 'soapAction')) ?? base.soapAction;
            const style =
                normalizeStyle(getAttribute(soapOperation ?? operationElement, 'style')) ?? defaultStyle ?? base.style;
            const use = normalizeUse(getAttribute(body ?? operationElement, 'use')) ?? base.use;
            if (soapAction !== undefined) {
                merged.soapAction = soapAction;
            }
            if (style !== undefined) {
                merged.style = style;
            }
            if (use !== undefined) {
                merged.use = use;
            }
            operations.set(name, merged);
        }
    }

    return operations;
}

function parseServiceLocation(definitions: XmlElement): string | undefined {
    const address = descendantElements(definitions, 'address')[0];
    return address ? getAttribute(address, 'location') : undefined;
}

function normalizeStyle(value: string | undefined): 'rpc' | 'document' | undefined {
    return value === 'rpc' || value === 'document' ? value : undefined;
}

function normalizeUse(value: string | undefined): 'literal' | 'encoded' | undefined {
    return value === 'literal' || value === 'encoded' ? value : undefined;
}
