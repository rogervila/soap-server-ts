import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSoapFetchHandler, SoapFault, SoapServer } from '../src/index.js';

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

function soapRequest(body: string, init: RequestInit = {}): Request {
    return new Request('https://example.com/soap', {
        method: 'POST',
        headers: {
            'content-type': 'text/xml; charset=utf-8',
            ...(init.headers as Record<string, string> | undefined),
        },
        body,
        ...init,
    });
}

describe('SoapServer Fetch handling', () => {
    it('dispatches a registered function and returns a SOAP response', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction('add', (a, b) => Number(a) + Number(b));

        const response = await server.handle(soapRequest(await fixture('add-request.xml')));
        const xml = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/xml');
        expect(xml).toContain('<ns1:addResponse xmlns:ns1="urn:calculator">');
        expect(xml).toContain('<return xsi:type="xsd:int">5</return>');
    });

    it('exposes a reusable Fetch handler adapter', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction({ add: (a, b) => Number(a) + Number(b) });
        const handler = createSoapFetchHandler(server);

        const response = await handler(soapRequest(await fixture('add-request.xml')));

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('<return xsi:type="xsd:int">5</return>');
    });

    it('dispatches methods on setObject targets', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.setObject({
            add(a: unknown, b: unknown) {
                return Number(a) + Number(b);
            },
        });

        const response = await server.handle(soapRequest(await fixture('add-request.xml')));

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('<return xsi:type="xsd:int">5</return>');
    });

    it('creates a new setClass instance per request', async () => {
        class CounterService {
            private count = 0;

            add(a: unknown, b: unknown): number {
                this.count += 1;
                return Number(a) + Number(b) + this.count;
            }
        }

        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.setClass(CounterService);

        const first = await server.handle(soapRequest(await fixture('add-request.xml')));
        const second = await server.handle(soapRequest(await fixture('add-request.xml')));

        await expect(first.text()).resolves.toContain('<return xsi:type="xsd:int">6</return>');
        await expect(second.text()).resolves.toContain('<return xsi:type="xsd:int">6</return>');
    });

    it('turns unknown operations into SOAP faults', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        const request = (await fixture('add-request.xml')).replaceAll('add', 'missing');

        const response = await server.handle(soapRequest(request));
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('<SOAP-ENV:Fault>');
        expect(xml).toContain('Function "missing" is not a valid method');
    });

    it('turns thrown SoapFaults into fault responses', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction('add', () => {
            throw new SoapFault('Client', 'Nope');
        });

        const response = await server.handle(soapRequest(await fixture('add-request.xml')));
        const xml = await response.text();

        expect(response.status).toBe(500);
        expect(xml).toContain('<faultcode>SOAP-ENV:Client</faultcode>');
        expect(xml).toContain('<faultstring>Nope</faultstring>');
    });

    it('rejects unsupported content types with a SOAP fault', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });

        const response = await server.handle(
            soapRequest(await fixture('add-request.xml'), {
                headers: { 'content-type': 'application/json' },
            }),
        );

        expect(response.status).toBe(415);
        await expect(response.text()).resolves.toContain('Unsupported SOAP Content-Type');
    });

    it('returns 405 for unsupported HTTP methods', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });

        const response = await server.handle(new Request('https://example.com/soap', { method: 'DELETE' }));

        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET, POST');
    });

    it('enforces mustUnderstand headers unless a target method handles them', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const request = `<?xml version="1.0"?>
      <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
        <SOAP-ENV:Header><Auth SOAP-ENV:mustUnderstand="1"><token>secret</token></Auth></SOAP-ENV:Header>
        <SOAP-ENV:Body><add><a>2</a><b>3</b></add></SOAP-ENV:Body>
      </SOAP-ENV:Envelope>`;

        const response = await server.handle(soapRequest(request));

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toContain('SOAP header "Auth" was not understood');
    });

    it('dispatches understood headers before the body operation', async () => {
        const calls: string[] = [];
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.setObject({
            Auth(value: unknown) {
                calls.push(`Auth:${JSON.stringify(value)}`);
            },
            add(a: unknown, b: unknown) {
                calls.push('add');
                return Number(a) + Number(b);
            },
        });
        const request = `<?xml version="1.0"?>
      <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
        <SOAP-ENV:Header><Auth SOAP-ENV:mustUnderstand="1"><token>secret</token></Auth></SOAP-ENV:Header>
        <SOAP-ENV:Body><add><a>2</a><b>3</b></add></SOAP-ENV:Body>
      </SOAP-ENV:Envelope>`;

        const response = await server.handle(soapRequest(request));

        expect(response.status).toBe(200);
        expect(calls).toEqual(['Auth:{"token":"secret"}', 'add']);
    });

    it('handles SOAP 1.2 content type and response namespace', async () => {
        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const request = `<?xml version="1.0"?>
      <env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
        <env:Body><add><a>2</a><b>3</b></add></env:Body>
      </env:Envelope>`;

        const response = await server.handle(
            soapRequest(request, {
                headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
            }),
        );

        expect(response.headers.get('content-type')).toContain('application/soap+xml');
        await expect(response.text()).resolves.toContain('<env:Envelope');
    });
});
