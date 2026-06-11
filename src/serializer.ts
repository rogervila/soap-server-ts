import { mapFaultCodeForVersion, SoapFault } from './fault.js';
import type { OutgoingSoapHeader, SoapResponseOptions, SoapVersion } from './types.js';
import {
    SOAP_ENCODING_NS,
    SOAP11_ENVELOPE_NS,
    SOAP12_ENVELOPE_NS,
    XML_SCHEMA_INSTANCE_NS,
    XML_SCHEMA_NS,
} from './xml.js';

export function serializeSoapResponse(options: SoapResponseOptions & { headers?: OutgoingSoapHeader[] }): string {
    const envelopeNamespace = envelopeNamespaceForVersion(options.soapVersion);
    const responseName = `${options.operationName}Response`;
    const namespaceAttribute = options.namespaceURI ? ` xmlns:ns1="${escapeAttribute(options.namespaceURI)}"` : '';
    const responsePrefix = options.namespaceURI ? 'ns1:' : '';
    const resultName = options.resultName ?? 'return';
    const body = `<${responsePrefix}${responseName}${namespaceAttribute}>${serializeValue(resultName, options.value)}</${responsePrefix}${responseName}>`;

    return serializeEnvelope(
        options.soapVersion,
        body,
        serializeHeaders(options.headers ?? [], options.soapVersion),
        envelopeNamespace,
    );
}

export function serializeSoapFault(fault: SoapFault, version: SoapVersion): string {
    const envelopeNamespace = envelopeNamespaceForVersion(version);
    const body = version === '1.2' ? serializeSoap12Fault(fault, version) : serializeSoap11Fault(fault, version);
    return serializeEnvelope(version, body, '', envelopeNamespace);
}

export function contentTypeForSoapVersion(version: SoapVersion): string {
    return version === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8';
}

function serializeEnvelope(version: SoapVersion, body: string, header: string, envelopeNamespace: string): string {
    const prefix = version === '1.2' ? 'env' : 'SOAP-ENV';
    return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<${prefix}:Envelope xmlns:${prefix}="${envelopeNamespace}" xmlns:xsd="${XML_SCHEMA_NS}" xmlns:xsi="${XML_SCHEMA_INSTANCE_NS}" xmlns:SOAP-ENC="${SOAP_ENCODING_NS}">` +
        header +
        `<${prefix}:Body>${body}</${prefix}:Body>` +
        `</${prefix}:Envelope>`
    );
}

function serializeHeaders(headers: OutgoingSoapHeader[], version: SoapVersion): string {
    if (headers.length === 0) {
        return '';
    }

    const prefix = version === '1.2' ? 'env' : 'SOAP-ENV';
    const blocks = headers
        .map((header, index) => {
            const namespacePrefix = header.namespaceURI ? `h${index}` : '';
            const qualifiedName = namespacePrefix ? `${namespacePrefix}:${header.name}` : header.name;
            const namespaceAttribute = header.namespaceURI
                ? ` xmlns:${namespacePrefix}="${escapeAttribute(header.namespaceURI)}"`
                : '';
            const mustUnderstand = header.mustUnderstand
                ? ` ${prefix}:mustUnderstand="${version === '1.2' ? 'true' : '1'}"`
                : '';
            const actorName = version === '1.2' ? 'role' : 'actor';
            const actor = header.actor ? ` ${prefix}:${actorName}="${escapeAttribute(header.actor)}"` : '';
            return `<${qualifiedName}${namespaceAttribute}${mustUnderstand}${actor}>${serializeValueChildren(header.value)}</${qualifiedName}>`;
        })
        .join('');

    return `<${prefix}:Header>${blocks}</${prefix}:Header>`;
}

function serializeSoap11Fault(fault: SoapFault, version: SoapVersion): string {
    const faultcode = mapFaultCodeForVersion(fault.faultcode, version);
    const actor = fault.faultactor ? `<faultactor>${escapeText(fault.faultactor)}</faultactor>` : '';
    const detail = fault.detail === undefined ? '' : `<detail>${serializeValueChildren(fault.detail)}</detail>`;
    return `<SOAP-ENV:Fault><faultcode>${escapeText(faultcode)}</faultcode><faultstring>${escapeText(fault.faultstring)}</faultstring>${actor}${detail}</SOAP-ENV:Fault>`;
}

function serializeSoap12Fault(fault: SoapFault, version: SoapVersion): string {
    const faultcode = mapFaultCodeForVersion(fault.faultcode, version);
    const detail = fault.detail === undefined ? '' : `<env:Detail>${serializeValueChildren(fault.detail)}</env:Detail>`;
    return `<env:Fault><env:Code><env:Value>${escapeText(faultcode)}</env:Value></env:Code><env:Reason><env:Text xml:lang="en">${escapeText(fault.faultstring)}</env:Text></env:Reason>${detail}</env:Fault>`;
}

function envelopeNamespaceForVersion(version: SoapVersion): string {
    return version === '1.2' ? SOAP12_ENVELOPE_NS : SOAP11_ENVELOPE_NS;
}

function serializeValue(name: string, value: unknown): string {
    assertXmlName(name);

    if (value === null || value === undefined) {
        return `<${name} xsi:nil="true"/>`;
    }

    if (typeof value === 'string') {
        return `<${name} xsi:type="xsd:string">${escapeText(value)}</${name}>`;
    }

    if (typeof value === 'number') {
        const type = Number.isInteger(value) ? 'xsd:int' : 'xsd:double';
        return `<${name} xsi:type="${type}">${String(value)}</${name}>`;
    }

    if (typeof value === 'boolean') {
        return `<${name} xsi:type="xsd:boolean">${value ? 'true' : 'false'}</${name}>`;
    }

    if (value instanceof Date) {
        return `<${name} xsi:type="xsd:dateTime">${escapeText(value.toISOString())}</${name}>`;
    }

    if (Array.isArray(value)) {
        const items = value.map((item) => serializeValue('item', item)).join('');
        return `<${name} SOAP-ENC:arrayType="xsd:anyType[${value.length}]">${items}</${name}>`;
    }

    if (typeof value === 'object') {
        return `<${name}>${serializeValueChildren(value)}</${name}>`;
    }

    return `<${name} xsi:type="xsd:string">${escapeText(String(value))}</${name}>`;
}

function serializeValueChildren(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }

    if (Array.isArray(value)) {
        return value.map((item) => serializeValue('item', item)).join('');
    }

    if (typeof value !== 'object') {
        return escapeText(String(value));
    }

    return Object.entries(value as Record<string, unknown>)
        .filter(([, childValue]) => childValue !== undefined)
        .map(([childName, childValue]) => serializeValue(childName, childValue))
        .join('');
}

function assertXmlName(name: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) {
        throw new SoapFault('Server', `Cannot serialize invalid XML element name "${name}"`, { status: 500 });
    }
}

function escapeText(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
    return escapeText(value).replaceAll('"', '&quot;');
}
