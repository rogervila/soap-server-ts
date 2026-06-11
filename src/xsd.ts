import type { XmlDocument as LibXmlDocument, XsdValidator as LibXmlXsdValidator } from 'libxml2-wasm';
import type { ParsedSoapEnvelopeForDispatch } from './envelope.js';
import { SoapFault } from './fault.js';
import type { WsdlMetadata, WsdlOperation, WsdlPart, WsdlQName, WsdlSchema, WsdlSchemaComponent } from './types.js';
import {
    elementChildren,
    firstElementChildByLocalName,
    getAttribute,
    localName,
    parseXmlDocument,
    resolveQName,
    serializeXmlElement,
    textContent,
    XML_SCHEMA_NS,
    type XmlElement,
} from './xml.js';

type LibXmlModule = typeof import('libxml2-wasm');

interface CompiledSchema {
    libxml: LibXmlModule;
    schema: WsdlSchema;
    document: LibXmlDocument;
    validator: LibXmlXsdValidator;
}

interface XsdContext {
    schemasByNamespace: Map<string, CompiledSchema>;
}

interface XsdValidationOptions {
    strict: boolean;
}

const LIBXML_PACKAGE = 'libxml2-wasm';
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
const BOOLEAN_PATTERN = /^(?:true|false|0|1)$/i;

const contextCache = new WeakMap<WsdlMetadata, Promise<XsdContext>>();
const componentCache = new WeakMap<WsdlSchemaComponent, XmlElement>();
let libxmlPromise: Promise<LibXmlModule> | undefined;

export async function validateWsdlRequestWithXsd(
    metadata: WsdlMetadata,
    operation: WsdlOperation,
    parsed: ParsedSoapEnvelopeForDispatch,
    options: XsdValidationOptions,
): Promise<void> {
    if (metadata.schemas.length === 0) {
        return;
    }

    for (let index = 0; index < operation.inputParts.length; index += 1) {
        const part = operation.inputParts[index];
        if (part?.elementQName) {
            validatePresentElementTypes(metadata, part, parsed, index);
        }
    }

    if (!options.strict) {
        return;
    }

    const context = await getXsdContext(metadata);
    for (let index = 0; index < operation.inputParts.length; index += 1) {
        const part = operation.inputParts[index];
        if (part?.elementQName) {
            validateStrictElementPart(context, part, parsed, index);
        }
    }
}

async function getXsdContext(metadata: WsdlMetadata): Promise<XsdContext> {
    const cached = contextCache.get(metadata);
    if (cached) {
        return cached;
    }

    const created = createXsdContext(metadata);
    contextCache.set(metadata, created);
    return created;
}

async function createXsdContext(metadata: WsdlMetadata): Promise<XsdContext> {
    const libxml = await loadLibXml();
    const schemasByNamespace = new Map<string, CompiledSchema>();

    for (const schema of metadata.schemas) {
        const document = libxml.XmlDocument.fromString(schema.xml, { url: schemaUrl(schema) });
        const validator = libxml.XsdValidator.fromDoc(document);
        schemasByNamespace.set(schema.targetNamespace ?? '', { libxml, schema, document, validator });
    }

    return { schemasByNamespace };
}

function validatePresentElementTypes(
    metadata: WsdlMetadata,
    part: WsdlPart,
    parsed: ParsedSoapEnvelopeForDispatch,
    index: number,
): void {
    const qname = part.elementQName;
    if (!qname) {
        return;
    }

    const element = findElementPartCandidate(parsed, qname, index);
    if (!element) {
        return;
    }

    const component = findSchemaComponent(metadata, 'element', qname);
    if (!component) {
        return;
    }

    validateElementAgainstDeclaration(metadata, element, componentElement(component), part.name);
}

function validateStrictElementPart(
    context: XsdContext,
    part: WsdlPart,
    parsed: ParsedSoapEnvelopeForDispatch,
    index: number,
): void {
    const qname = part.elementQName;
    if (!qname) {
        return;
    }

    const element = findElementPartCandidate(parsed, qname, index);
    if (!element) {
        throw encodingViolationFault(part.name);
    }

    const compiled = context.schemasByNamespace.get(qname.namespaceURI ?? '');
    if (!compiled) {
        return;
    }

    validateElementXml(compiled, element, part.name);
}

function validateElementAgainstDeclaration(
    metadata: WsdlMetadata,
    element: XmlElement,
    declaration: XmlElement,
    parameterName: string,
): void {
    const type = resolveQName(declaration, getAttribute(declaration, 'type'));
    if (type) {
        validateElementAgainstType(metadata, element, type, parameterName);
        return;
    }

    const simpleType = firstElementChildByLocalName(declaration, 'simpleType');
    if (simpleType) {
        validateSimpleType(metadata, element, simpleType, parameterName);
        return;
    }

    const complexType = firstElementChildByLocalName(declaration, 'complexType');
    if (complexType) {
        validateComplexType(metadata, element, complexType, parameterName);
    }
}

function validateElementAgainstType(
    metadata: WsdlMetadata,
    element: XmlElement,
    type: { namespaceURI: string | null; localName: string },
    parameterName: string,
): void {
    if (type.namespaceURI === XML_SCHEMA_NS) {
        validateBuiltInType(type.localName, textContent(element), parameterName);
        return;
    }

    const lookup =
        type.namespaceURI === null
            ? { localName: type.localName }
            : { localName: type.localName, namespaceURI: type.namespaceURI };
    const component = findSchemaComponent(metadata, 'type', lookup);
    if (!component) {
        return;
    }

    const typeElement = componentElement(component);
    if (localName(typeElement) === 'simpleType') {
        validateSimpleType(metadata, element, typeElement, parameterName);
    } else if (localName(typeElement) === 'complexType') {
        validateComplexType(metadata, element, typeElement, parameterName);
    }
}

function validateComplexType(
    metadata: WsdlMetadata,
    element: XmlElement,
    complexType: XmlElement,
    parameterName: string,
): void {
    const sequence = firstElementChildByLocalName(complexType, 'sequence');
    if (!sequence) {
        return;
    }

    const declarations = new Map<string, XmlElement>();
    for (const declaration of elementChildren(sequence).filter((child) => localName(child) === 'element')) {
        const name = getAttribute(declaration, 'name');
        if (name) {
            declarations.set(name, declaration);
        }
    }

    for (const child of element.children) {
        const declaration = declarations.get(child.localName);
        if (declaration) {
            validateElementAgainstDeclaration(metadata, child, declaration, parameterName);
        }
    }
}

function validateSimpleType(
    metadata: WsdlMetadata,
    element: XmlElement,
    simpleType: XmlElement,
    parameterName: string,
): void {
    const restriction = firstElementChildByLocalName(simpleType, 'restriction');
    if (!restriction) {
        return;
    }

    const base = resolveQName(restriction, getAttribute(restriction, 'base'));
    if (base?.namespaceURI === XML_SCHEMA_NS) {
        validateBuiltInType(base.localName, textContent(element), parameterName);
    } else if (base) {
        validateElementAgainstType(metadata, element, base, parameterName);
    }

    validateFacets(element, restriction, parameterName);
}

function validateFacets(element: XmlElement, restriction: XmlElement, parameterName: string): void {
    const value = textContent(element);
    for (const facet of elementChildren(restriction)) {
        const facetValue = getAttribute(facet, 'value');
        if (facetValue === undefined) {
            continue;
        }

        if (localName(facet) === 'enumeration' && value !== facetValue) {
            throw encodingViolationFault(parameterName);
        }
        if (localName(facet) === 'length' && value.length !== Number.parseInt(facetValue, 10)) {
            throw encodingViolationFault(parameterName);
        }
        if (localName(facet) === 'minLength' && value.length < Number.parseInt(facetValue, 10)) {
            throw encodingViolationFault(parameterName);
        }
        if (localName(facet) === 'maxLength' && value.length > Number.parseInt(facetValue, 10)) {
            throw encodingViolationFault(parameterName);
        }
        if (localName(facet) === 'pattern' && !new RegExp(`^(?:${facetValue})$`).test(value)) {
            throw encodingViolationFault(parameterName);
        }
    }
}

function validateBuiltInType(typeName: string, value: string, parameterName: string): void {
    const trimmed = value.trim();
    if (INTEGER_TYPES.has(typeName) && !INTEGER_PATTERN.test(trimmed)) {
        throw encodingViolationFault(parameterName);
    }
    if (FLOAT_TYPES.has(typeName) && !FLOAT_PATTERN.test(trimmed)) {
        throw encodingViolationFault(parameterName);
    }
    if ((typeName === 'boolean' || typeName === 'bool') && !BOOLEAN_PATTERN.test(trimmed)) {
        throw encodingViolationFault(parameterName);
    }
}

function findElementPartCandidate(
    parsed: ParsedSoapEnvelopeForDispatch,
    qname: WsdlQName,
    index: number,
): XmlElement | undefined {
    if (matchesQName(parsed.operationElement, qname)) {
        return parsed.operationElement;
    }

    const named = parsed.parameterElementsByName.get(qname.localName)?.find((element) => matchesQName(element, qname));
    return named ?? parsed.parameterElements[index];
}

function matchesQName(element: XmlElement, qname: WsdlQName): boolean {
    if (element.localName !== qname.localName) {
        return false;
    }
    return qname.namespaceURI === undefined || element.namespaceURI === qname.namespaceURI;
}

function findSchemaComponent(
    metadata: WsdlMetadata,
    kind: 'element' | 'type',
    qname: { localName: string; namespaceURI?: string },
): WsdlSchemaComponent | undefined {
    const key = `${qname.namespaceURI ?? ''}\u0000${qname.localName}`;
    for (const schema of metadata.schemas) {
        const component = kind === 'element' ? schema.elements.get(key) : schema.types.get(key);
        if (component) {
            return component;
        }
    }
    return undefined;
}

function componentElement(component: WsdlSchemaComponent): XmlElement {
    const cached = componentCache.get(component);
    if (cached) {
        return cached;
    }

    const parsed = parseXmlDocument(component.xml).documentElement;
    componentCache.set(component, parsed);
    return parsed;
}

function validateElementXml(compiled: CompiledSchema, element: XmlElement, partName: string): void {
    let document: LibXmlDocument | undefined;
    try {
        document = compiledDocumentFromElement(compiled, element);
        compiled.validator.validate(document);
    } catch (error) {
        throw encodingViolationFault(partName, error);
    } finally {
        document?.dispose();
    }
}

function compiledDocumentFromElement(compiled: CompiledSchema, element: XmlElement): LibXmlDocument {
    const xml = serializeXmlElement(element, { includeInheritedNamespaces: true });
    return compiled.libxml.XmlDocument.fromString(xml);
}

function schemaUrl(schema: WsdlSchema): string {
    return `urn:soap-server-ts:xsd:${encodeURIComponent(schema.targetNamespace ?? 'default')}`;
}

function encodingViolationFault(parameter: string, cause?: unknown): SoapFault {
    return new SoapFault('Server', 'SOAP-ERROR: Encoding: Violation of encoding rules', {
        detail: {
            parameter,
            validation: cause instanceof Error ? cause.message : undefined,
        },
        status: 500,
    });
}

async function loadLibXml(): Promise<LibXmlModule> {
    libxmlPromise ??= import(LIBXML_PACKAGE) as Promise<LibXmlModule>;
    return libxmlPromise;
}

export function isXmlSchemaNamespace(namespaceURI: string | undefined): boolean {
    return namespaceURI === XML_SCHEMA_NS;
}
