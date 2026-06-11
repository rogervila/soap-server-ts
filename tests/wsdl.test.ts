import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWsdl, SoapServer } from '../src/index.js';

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('WSDL mode', () => {
    it('parses WSDL 1.1 operation metadata', async () => {
        const wsdl = parseWsdl(await fixture('calculator.wsdl'));
        const add = wsdl.operations.get('add');

        expect(wsdl.targetNamespace).toBe('urn:calculator');
        expect(wsdl.serviceLocation).toBe('https://example.com/soap');
        expect(add?.soapAction).toBe('urn:calculator#add');
        expect(add?.style).toBe('rpc');
        expect(add?.use).toBe('encoded');
        expect(add?.inputParts.map((part) => part.name)).toEqual(['a', 'b']);
    });

    it('returns configured WSDL XML on HTTP GET', async () => {
        const wsdlXml = await fixture('calculator.wsdl');
        const server = new SoapServer(wsdlXml);

        const response = await server.handle(new Request('https://example.com/soap?wsdl', { method: 'GET' }));

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe(wsdlXml);
    });

    it('validates WSDL operations and uses output part names', async () => {
        const server = new SoapServer(await fixture('calculator.wsdl'));
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const request = await fixture('add-request.xml');

        const response = await server.handle(
            new Request('https://example.com/soap', {
                method: 'POST',
                headers: {
                    'content-type': 'text/xml',
                    SOAPAction: '"urn:calculator#add"',
                },
                body: request,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(200);
        expect(xml).toContain('<return xsi:type="xsd:int">5</return>');
    });

    it('keeps PHP-compatible behavior for missing WSDL rpc parameters', async () => {
        const server = new SoapServer(await fixture('calculator.wsdl'));
        server.addFunction('add', (a, b) => Number(a) + Number(b));

        const response = await server.handle(
            new Request('https://example.com/soap', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
                    <SOAP-ENV:Body><ns1:add xmlns:ns1="urn:calculator"><a>2</a></ns1:add></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('<return xsi:type="xsd:int">2</return>');
    });

    it('rejects non-numeric values for WSDL xsd:int input parts', async () => {
        const server = new SoapServer(await fixture('calculator.wsdl'));
        server.addFunction('add', (a, b) => Number(a) + Number(b));

        const response = await server.handle(
            new Request('https://example.com/soap', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
                    <SOAP-ENV:Body><ns1:add xmlns:ns1="urn:calculator"><a>2</a><b>abc</b></ns1:add></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('<SOAP-ENV:Fault>');
        expect(xml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });

    it('rejects invalid explicitly typed WSDL integer values before dispatch', async () => {
        const server = new SoapServer(await fixture('calculator.wsdl'));
        server.addFunction('add', () => {
            throw new Error('handler should not run');
        });

        const response = await server.handle(
            new Request('https://example.com/soap', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
                    <SOAP-ENV:Body><ns1:add xmlns:ns1="urn:calculator"><a xsi:type="xsd:int">2</a><b xsi:type="xsd:int">abc</b></ns1:add></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });

    it('loads WSDL through a serverless-safe loader abstraction', async () => {
        const wsdlXml = await fixture('calculator.wsdl');
        const server = new SoapServer('https://metadata.example/wsdl', {
            wsdlLoader: ({ url }) => {
                expect(url).toBe('https://metadata.example/wsdl');
                return wsdlXml;
            },
        });
        server.addFunction('add', (a, b) => Number(a) + Number(b));

        const response = await server.handle(
            new Request('https://example.com/soap', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: await fixture('add-request.xml'),
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('<return xsi:type="xsd:int">5</return>');
    });

    it('validates document/literal requests against embedded XSD schemas', async () => {
        const server = new SoapServer(await fixture('user-document.wsdl'));
        server.addFunction('createUser', (payload) => {
            const user = payload as { name: string; age: number };
            return `${user.name}:${user.age}`;
        });

        const response = await server.handle(
            new Request('https://example.com/user', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name><u:age>37</u:age></u:createUser></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(200);
        expect(xml).toContain('<parameters xsi:type="xsd:string">Ada:37</parameters>');
    });

    it('keeps PHP-compatible behavior for document/literal requests missing required XSD elements by default', async () => {
        const server = new SoapServer(await fixture('user-document.wsdl'));
        server.addFunction('createUser', (payload) => {
            const user = payload as { name: string; age?: number };
            return user.age === undefined ? `${user.name}:missing` : `${user.name}:${user.age}`;
        });

        const response = await server.handle(
            new Request('https://example.com/user', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name></u:createUser></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('<parameters xsi:type="xsd:string">Ada:missing</parameters>');
    });

    it('rejects document/literal requests with invalid XSD scalar content', async () => {
        const server = new SoapServer(await fixture('user-document.wsdl'));
        server.addFunction('createUser', () => {
            throw new Error('handler should not run');
        });

        const response = await server.handle(
            new Request('https://example.com/user', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name><u:age>abc</u:age></u:createUser></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });

    it('keeps PHP-compatible behavior for document/literal requests with unexpected XSD elements by default', async () => {
        const server = new SoapServer(await fixture('user-document.wsdl'));
        server.addFunction('createUser', (payload) => {
            const user = payload as { name: string; age: number };
            return `${user.name}:${user.age}`;
        });

        const response = await server.handle(
            new Request('https://example.com/user', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name><u:age>37</u:age><u:extra>nope</u:extra></u:createUser></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('<parameters xsi:type="xsd:string">Ada:37</parameters>');
    });

    it('rejects document/literal requests missing required XSD elements in strict mode', async () => {
        const server = new SoapServer(await fixture('user-document.wsdl'), { strictXsdValidation: true });
        server.addFunction('createUser', () => {
            throw new Error('handler should not run');
        });

        const response = await server.handle(
            new Request('https://example.com/user', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name></u:createUser></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });

    it('rejects document/literal requests with unexpected XSD elements in strict mode', async () => {
        const server = new SoapServer(await fixture('user-document.wsdl'), { strictXsdValidation: true });
        server.addFunction('createUser', () => {
            throw new Error('handler should not run');
        });

        const response = await server.handle(
            new Request('https://example.com/user', {
                method: 'POST',
                headers: { 'content-type': 'text/xml' },
                body: `<?xml version="1.0" encoding="UTF-8"?>
                  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name><u:age>37</u:age><u:extra>nope</u:extra></u:createUser></SOAP-ENV:Body>
                  </SOAP-ENV:Envelope>`,
            }),
        );
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });
});
