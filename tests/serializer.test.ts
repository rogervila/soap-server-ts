import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SoapFault, serializeSoapFault, serializeSoapResponse } from '../src/index.js';

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('SOAP serialization', () => {
    it('serializes scalar SOAP 1.1 responses to the golden fixture', async () => {
        const xml = serializeSoapResponse({
            operationName: 'add',
            namespaceURI: 'urn:calculator',
            soapVersion: '1.1',
            value: 5,
        });

        expect(`${xml}\n`).toBe(await fixture('add-response.xml'));
    });

    it('serializes structs, arrays, booleans, and nulls', () => {
        const xml = serializeSoapResponse({
            operationName: 'profile',
            soapVersion: '1.1',
            value: {
                name: 'Ada & Co',
                enabled: true,
                tags: ['math', 'logic'],
                missing: null,
            },
        });

        expect(xml).toContain('<name xsi:type="xsd:string">Ada &amp; Co</name>');
        expect(xml).toContain('<enabled xsi:type="xsd:boolean">true</enabled>');
        expect(xml).toContain('<tags SOAP-ENC:arrayType="xsd:anyType[2]">');
        expect(xml).toContain('<missing xsi:nil="true"/>');
    });

    it('serializes SOAP 1.2 faults', () => {
        const xml = serializeSoapFault(new SoapFault('Client', 'Bad request'), '1.2');

        expect(xml).toContain('<env:Fault>');
        expect(xml).toContain('<env:Value>env:Sender</env:Value>');
        expect(xml).toContain('<env:Text xml:lang="en">Bad request</env:Text>');
    });
});
