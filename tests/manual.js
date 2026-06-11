// RUN `pnpm run build && node tests/manual.js` to try the server with SOAP clients like SoapUI or Postman.
// This file is dev-only and is not meant to be run in automated tests.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { SoapServer } from '../dist/index.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const publicHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
const soapUrl = process.env.SOAP_URL ?? `http://${publicHost}:${PORT}/soap`;
const wsdlUrl = `${soapUrl}?wsdl`;

const fixtureWsdl = await readFile(new URL('./fixtures/calculator.wsdl', import.meta.url), 'utf8');
const wsdl = fixtureWsdl.replace(
    /<soap:address\s+location="[^"]*"\s*\/>/,
    `<soap:address location="${escapeXmlAttribute(soapUrl)}" />`,
);

const soapServer = new SoapServer(wsdl);
soapServer.addFunction('add', (a, b) => Number(a) + Number(b));

const httpServer = createServer(async (nodeRequest, nodeResponse) => {
    try {
        const request = toFetchRequest(nodeRequest);
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/') {
            await writeNodeResponse(
                nodeResponse,
                new Response(manualHelpText(), {
                    status: 200,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                }),
            );
            return;
        }

        if (url.pathname !== '/soap') {
            await writeNodeResponse(
                nodeResponse,
                new Response('Not Found\n', {
                    status: 404,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                }),
            );
            return;
        }

        await writeNodeResponse(nodeResponse, await soapServer.handle(request));
    } catch (error) {
        console.error(error);
        await writeNodeResponse(
            nodeResponse,
            new Response('Internal manual server error\n', {
                status: 500,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
            }),
        );
    }
});

httpServer.listen(PORT, HOST, () => {
    console.log(`SOAP calculator manual server listening on http://${publicHost}:${PORT}`);
    console.log(`SoapUI WSDL URL: ${wsdlUrl}`);
    console.log('Operation: add(a: int, b: int)');
});

function toFetchRequest(nodeRequest) {
    const method = nodeRequest.method ?? 'GET';
    const host = nodeRequest.headers.host ?? `${publicHost}:${PORT}`;
    const url = new URL(nodeRequest.url ?? '/', `http://${host}`);
    const init = {
        method,
        headers: toFetchHeaders(nodeRequest.headers),
    };

    if (method !== 'GET' && method !== 'HEAD') {
        init.body = nodeRequest;
        init.duplex = 'half';
    }

    return new Request(url, init);
}

function toFetchHeaders(nodeHeaders) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(nodeHeaders)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
            continue;
        }
        if (value !== undefined) {
            headers.set(name, value);
        }
    }
    return headers;
}

async function writeNodeResponse(nodeResponse, response) {
    nodeResponse.statusCode = response.status;
    nodeResponse.statusMessage = response.statusText;
    response.headers.forEach((value, name) => {
        nodeResponse.setHeader(name, value);
    });

    if (!response.body) {
        nodeResponse.end();
        return;
    }

    nodeResponse.end(new Uint8Array(await response.arrayBuffer()));
}

function manualHelpText() {
    return [
        'soap-server-ts manual calculator server',
        '',
        `SoapUI WSDL URL: ${wsdlUrl}`,
        `SOAP endpoint: ${soapUrl}`,
        'Operation: add(a: int, b: int)',
        '',
    ].join('\n');
}

function escapeXmlAttribute(value) {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
