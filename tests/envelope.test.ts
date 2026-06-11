import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSoapEnvelope, SoapFault } from '../src/index.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const fixture = (name: string) => readFile(fileURLToPath(fixtureUrl(name)), 'utf8');

describe('SOAP envelope parsing', () => {
    it('parses a SOAP 1.1 operation and typed scalar parameters', async () => {
        const parsed = parseSoapEnvelope(await fixture('add-request.xml'), { inferTypes: true });

        expect(parsed.operationName).toBe('add');
        expect(parsed.namespaceURI).toBe('urn:calculator');
        expect(parsed.parameters).toEqual([2, 3]);
        expect(parsed.namedParameters).toEqual({ a: 2, b: 3 });
        expect(parsed.soapVersion).toBe('1.1');
    });

    it('parses structs and encoded arrays', async () => {
        const parsed = parseSoapEnvelope(await fixture('struct-request.xml'), { inferTypes: true });

        expect(parsed.operationName).toBe('summarize');
        expect(parsed.parameters).toEqual([
            {
                name: 'Ada',
                active: true,
                scores: [1, 2, 3],
            },
        ]);
    });

    it('throws a SOAP client fault for malformed XML', () => {
        expect(() => parseSoapEnvelope('<Envelope><broken></Envelope>', { inferTypes: true })).toThrow(SoapFault);
    });

    it('throws a SOAP fault for invalid explicitly typed integer values', () => {
        const request = `<?xml version="1.0" encoding="UTF-8"?>
                    <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
                        <SOAP-ENV:Body><add><a xsi:type="xsd:int">abc</a></add></SOAP-ENV:Body>
                    </SOAP-ENV:Envelope>`;

        expect(() => parseSoapEnvelope(request, { inferTypes: true })).toThrow(SoapFault);
    });
});
