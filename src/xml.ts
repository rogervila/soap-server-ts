import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const SOAP11_ENVELOPE_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const SOAP12_ENVELOPE_NS = 'http://www.w3.org/2003/05/soap-envelope';
export const SOAP_ENCODING_NS = 'http://schemas.xmlsoap.org/soap/encoding/';
export const WSDL11_NS = 'http://schemas.xmlsoap.org/wsdl/';
export const XML_SCHEMA_INSTANCE_NS = 'http://www.w3.org/2001/XMLSchema-instance';
export const XML_SCHEMA_NS = 'http://www.w3.org/2001/XMLSchema';

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const ATTRIBUTES_KEY = ':@';
const TEXT_KEY = '#text';
const CDATA_KEY = '#cdata';

export interface XmlDocument {
    documentElement: XmlElement;
}

export interface XmlElement {
    name: string;
    prefix: string | null;
    localName: string;
    namespaceURI: string | null;
    namespaces: Readonly<Record<string, string>>;
    attributes: XmlAttribute[];
    children: XmlElement[];
    text: string;
}

export interface XmlAttribute {
    name: string;
    prefix: string | null;
    localName: string;
    namespaceURI: string | null;
    value: string;
}

export interface XmlQName {
    rawName: string;
    prefix: string | null;
    localName: string;
    namespaceURI: string | null;
}

type PreservedNode = Record<string, unknown>;
type NamespaceScope = Map<string, string>;

const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    attributeNamePrefix: '',
    attributesGroupName: ATTRIBUTES_KEY,
    textNodeName: TEXT_KEY,
    cdataPropName: CDATA_KEY,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    allowBooleanAttributes: true,
});

export function parseXmlDocument(xml: string): XmlDocument {
    const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
    if (validation !== true) {
        const error = validation.err;
        throw new Error(error ? `Malformed XML at ${error.line}:${error.col}: ${error.msg}` : 'Malformed XML');
    }

    const parsed = parser.parse(xml) as PreservedNode[];
    const roots = parsed.flatMap((node) => {
        const entry = elementEntry(node);
        return entry ? [buildElement(entry.name, entry.children, entry.attributes, new Map())] : [];
    });

    if (roots.length !== 1) {
        throw new Error(
            roots.length === 0
                ? 'Malformed XML: missing document element'
                : 'Malformed XML: multiple document elements',
        );
    }

    const documentElement = roots[0];
    if (!documentElement) {
        throw new Error('Malformed XML: missing document element');
    }

    return { documentElement };
}

export function localName(node: XmlElement | XmlAttribute | null | undefined): string {
    return node?.localName ?? '';
}

export function namespaceURI(node: XmlElement | XmlAttribute | null | undefined): string | null {
    return node?.namespaceURI ?? null;
}

export function elementChildren(element: XmlElement): XmlElement[] {
    return element.children;
}

export function firstElementChildByLocalName(element: XmlElement, name: string): XmlElement | undefined {
    return element.children.find((child) => child.localName === name);
}

export function descendantElements(element: XmlElement, name?: string): XmlElement[] {
    const found: XmlElement[] = [];
    const visit = (current: XmlElement): void => {
        for (const child of current.children) {
            if (!name || child.localName === name) {
                found.push(child);
            }
            visit(child);
        }
    };
    visit(element);
    return found;
}

export function getAttribute(element: XmlElement, name: string): string | undefined {
    return element.attributes.find((attribute) => attribute.name === name)?.value;
}

export function getAttributeByLocalName(element: XmlElement, name: string): string | undefined {
    return element.attributes.find((attribute) => attribute.localName === name)?.value;
}

export function getAttributeNS(element: XmlElement, namespace: string, name: string): string | undefined {
    return element.attributes.find((attribute) => attribute.namespaceURI === namespace && attribute.localName === name)
        ?.value;
}

export function lookupNamespaceURI(element: XmlElement, prefix: string | null | undefined): string | undefined {
    return element.namespaces[prefix ?? ''];
}

export function resolveQName(element: XmlElement, value: string | undefined): XmlQName | undefined {
    if (!value) {
        return undefined;
    }
    const qualifiedName = splitQualifiedName(value);
    return {
        rawName: value,
        prefix: qualifiedName.prefix,
        localName: qualifiedName.localName,
        namespaceURI: lookupNamespaceURI(element, qualifiedName.prefix) ?? null,
    };
}

export function textContent(element: XmlElement): string {
    return element.text;
}

export function stripPrefix(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const index = value.indexOf(':');
    return index === -1 ? value : value.slice(index + 1);
}

export function normalizeSoapAction(value: string | null | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

export function serializeXmlElement(
    element: XmlElement,
    options: { includeInheritedNamespaces?: boolean } = {},
): string {
    return serializeElement(element, options.includeInheritedNamespaces === true);
}

function buildElement(
    name: string,
    children: PreservedNode[],
    rawAttributes: Record<string, unknown>,
    inheritedNamespaces: NamespaceScope,
): XmlElement {
    const namespaceScope = new Map(inheritedNamespaces);

    for (const [attributeName, value] of Object.entries(rawAttributes)) {
        if (attributeName === 'xmlns') {
            namespaceScope.set('', String(value));
        } else if (attributeName.startsWith('xmlns:')) {
            namespaceScope.set(attributeName.slice('xmlns:'.length), String(value));
        }
    }

    const qualifiedName = splitQualifiedName(name);
    const element: XmlElement = {
        name,
        prefix: qualifiedName.prefix,
        localName: qualifiedName.localName,
        namespaceURI: namespaceForName(qualifiedName.prefix, namespaceScope, true),
        namespaces: Object.fromEntries(namespaceScope),
        attributes: Object.entries(rawAttributes).map(([attributeName, value]) =>
            buildAttribute(attributeName, String(value), namespaceScope),
        ),
        children: [],
        text: '',
    };

    for (const childNode of children) {
        if (Object.hasOwn(childNode, TEXT_KEY)) {
            element.text += textValue(childNode[TEXT_KEY]);
            continue;
        }
        if (Object.hasOwn(childNode, CDATA_KEY)) {
            element.text += textValue(childNode[CDATA_KEY]);
            continue;
        }

        const entry = elementEntry(childNode);
        if (entry) {
            element.children.push(buildElement(entry.name, entry.children, entry.attributes, namespaceScope));
        }
    }

    return element;
}

function serializeElement(element: XmlElement, includeInheritedNamespaces: boolean): string {
    const attributes = new Map<string, string>();

    for (const attribute of element.attributes) {
        attributes.set(attribute.name, attribute.value);
    }

    if (includeInheritedNamespaces) {
        for (const [prefix, uri] of Object.entries(element.namespaces)) {
            const attributeName = prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
            if (!attributes.has(attributeName)) {
                attributes.set(attributeName, uri);
            }
        }
    }

    const attributeText = [...attributes.entries()]
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join('');
    const text = escapeText(element.text);
    const children = element.children.map((child) => serializeElement(child, false)).join('');

    if (!text && !children) {
        return `<${element.name}${attributeText}/>`;
    }

    return `<${element.name}${attributeText}>${text}${children}</${element.name}>`;
}

function escapeText(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
    return escapeText(value).replaceAll('"', '&quot;');
}

function buildAttribute(name: string, value: string, namespaceScope: NamespaceScope): XmlAttribute {
    const qualifiedName = splitQualifiedName(name);
    const isNamespaceDeclaration = name === 'xmlns' || qualifiedName.prefix === 'xmlns';
    return {
        name,
        prefix: qualifiedName.prefix,
        localName: qualifiedName.localName,
        namespaceURI: isNamespaceDeclaration ? XMLNS_NS : namespaceForName(qualifiedName.prefix, namespaceScope, false),
        value,
    };
}

function elementEntry(
    node: PreservedNode,
): { name: string; children: PreservedNode[]; attributes: Record<string, unknown> } | undefined {
    for (const [key, value] of Object.entries(node)) {
        if (
            key === ATTRIBUTES_KEY ||
            key === TEXT_KEY ||
            key === CDATA_KEY ||
            key.startsWith('?') ||
            key.startsWith('!')
        ) {
            continue;
        }

        return {
            name: key,
            children: Array.isArray(value) ? (value as PreservedNode[]) : [{ [TEXT_KEY]: value }],
            attributes: isRecord(node[ATTRIBUTES_KEY]) ? node[ATTRIBUTES_KEY] : {},
        };
    }

    return undefined;
}

function splitQualifiedName(name: string): { prefix: string | null; localName: string } {
    const index = name.indexOf(':');
    if (index === -1) {
        return { prefix: null, localName: name };
    }
    return { prefix: name.slice(0, index), localName: name.slice(index + 1) };
}

function namespaceForName(
    prefix: string | null,
    namespaceScope: NamespaceScope,
    useDefaultNamespace: boolean,
): string | null {
    if (prefix) {
        return namespaceScope.get(prefix) ?? null;
    }
    return useDefaultNamespace ? (namespaceScope.get('') ?? null) : null;
}

function textValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value
            .map((entry) => (isRecord(entry) ? textValue(entry[TEXT_KEY] ?? entry[CDATA_KEY] ?? '') : String(entry)))
            .join('');
    }
    return value === undefined || value === null ? '' : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
