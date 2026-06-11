import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SoapServer } from '../src/index.js';

const PHP_BIN = process.env.PHP_BIN ?? 'php';
const calculatorWsdlPath = fileURLToPath(new URL('./fixtures/calculator.wsdl', import.meta.url));
const userDocumentWsdlPath = fileURLToPath(new URL('./fixtures/user-document.wsdl', import.meta.url));
const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const phpStatus = detectPhpSoap();
const phpDescribe = phpStatus.available ? describe : describe.skip;

phpDescribe(`optional PHP SoapServer compatibility (${phpStatus.message})`, () => {
    it('matches the high-level non-WSDL add response shape', async () => {
        const request = await fixture('add-request.xml');
        const php = runPhpSoapServer(
            request,
            `
      function add($a, $b) { return $a + $b; }
      $server = new SoapServer(null, ['uri' => 'urn:calculator']);
      $server->addFunction('add');
    `,
        );

        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const tsXml = await server.handleXml(request);

        expect(php.status).toBe(0);
        expect(php.output).toContain('addResponse');
        expect(php.output).toContain('return');
        expect(php.output).toContain('5');
        expect(tsXml).toContain('addResponse');
        expect(tsXml).toContain('return');
        expect(tsXml).toContain('5');
    });

    it('documents PHP CLI fatal behavior for unknown non-WSDL methods', async () => {
        const request = (await fixture('add-request.xml')).replaceAll('add', 'missing');
        const php = runPhpSoapServer(
            request,
            `
      function add($a, $b) { return $a + $b; }
      $server = new SoapServer(null, ['uri' => 'urn:calculator']);
      $server->addFunction('add');
    `,
        );

        const server = new SoapServer(null, { uri: 'urn:calculator' });
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const tsXml = await server.handleXml(request);

        expect(php.status).not.toBe(0);
        expect(php.output).toContain("Function 'missing' doesn't exist");
        expect(tsXml).toContain('Fault');
        expect(tsXml).toContain('Function "missing" is not a valid method');
    });

    it('documents PHP WSDL behavior for missing rpc parameters', async () => {
        const request = `<?xml version="1.0" encoding="UTF-8"?>
                    <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
                        <SOAP-ENV:Body><ns1:add xmlns:ns1="urn:calculator"><a>2</a></ns1:add></SOAP-ENV:Body>
                    </SOAP-ENV:Envelope>`;
        const php = runPhpSoapServer(
            request,
            `
            function add($a, $b) { return $a + $b; }
            $server = new SoapServer(${JSON.stringify(calculatorWsdlPath)}, ['uri' => 'urn:calculator']);
            $server->addFunction('add');
        `,
        );

        const server = new SoapServer(await fixture('calculator.wsdl'));
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const tsXml = await server.handleXml(request);

        expect(php.status).toBe(0);
        expect(php.output).toContain('addResponse');
        expect(php.output).toContain('2');
        expect(tsXml).toContain('addResponse');
        expect(tsXml).toContain('<return xsi:type="xsd:int">2</return>');
    });

    it('matches PHP WSDL fault behavior for invalid integer parameters', async () => {
        const request = `<?xml version="1.0" encoding="UTF-8"?>
                    <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
                        <SOAP-ENV:Body><ns1:add xmlns:ns1="urn:calculator"><a>2</a><b>abc</b></ns1:add></SOAP-ENV:Body>
                    </SOAP-ENV:Envelope>`;
        const php = runPhpSoapServer(
            request,
            `
            function add($a, $b) { return $a + $b; }
            $server = new SoapServer(${JSON.stringify(calculatorWsdlPath)}, ['uri' => 'urn:calculator']);
            $server->addFunction('add');
        `,
        );

        const server = new SoapServer(await fixture('calculator.wsdl'));
        server.addFunction('add', (a, b) => Number(a) + Number(b));
        const tsXml = await server.handleXml(request);

        expect(php.status).not.toBe(0);
        expect(php.output).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
        expect(tsXml).toContain('Fault');
        expect(tsXml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });

    it('documents PHP document/literal tolerance for missing and extra elements', async () => {
        const requests = [
            `<?xml version="1.0" encoding="UTF-8"?>
                <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name></u:createUser></SOAP-ENV:Body>
                </SOAP-ENV:Envelope>`,
            `<?xml version="1.0" encoding="UTF-8"?>
                <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                    <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name><u:age>37</u:age><u:extra>nope</u:extra></u:createUser></SOAP-ENV:Body>
                </SOAP-ENV:Envelope>`,
        ];

        for (const request of requests) {
            const php = runPhpSoapServer(
                request,
                `
            function createUser($parameters) { return 'ok'; }
            $server = new SoapServer(${JSON.stringify(userDocumentWsdlPath)}, ['uri' => 'urn:user-service']);
            $server->addFunction('createUser');
        `,
            );

            const server = new SoapServer(await fixture('user-document.wsdl'));
            server.addFunction('createUser', () => 'ok');
            const tsXml = await server.handleXml(request);

            expect(php.status).toBe(0);
            expect(php.output).toContain('createUserResponse');
            expect(tsXml).toContain('createUserResponse');
        }
    });

    it('matches PHP document/literal fault behavior for invalid typed content', async () => {
        const request = `<?xml version="1.0" encoding="UTF-8"?>
            <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:user-service">
                <SOAP-ENV:Body><u:createUser><u:name>Ada</u:name><u:age>abc</u:age></u:createUser></SOAP-ENV:Body>
            </SOAP-ENV:Envelope>`;
        const php = runPhpSoapServer(
            request,
            `
            function createUser($parameters) { return 'ok'; }
            $server = new SoapServer(${JSON.stringify(userDocumentWsdlPath)}, ['uri' => 'urn:user-service']);
            $server->addFunction('createUser');
        `,
        );

        const server = new SoapServer(await fixture('user-document.wsdl'));
        server.addFunction('createUser', () => 'ok');
        const tsXml = await server.handleXml(request);

        expect(php.status).not.toBe(0);
        expect(php.output).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
        expect(tsXml).toContain('SOAP-ERROR: Encoding: Violation of encoding rules');
    });
});

if (!phpStatus.available) {
    describe('optional PHP SoapServer compatibility', () => {
        it.skip(phpStatus.message, () => undefined);
    });
}

function detectPhpSoap(): { available: boolean; message: string } {
    if (!existsSync(PHP_BIN)) {
        return { available: false, message: `skipped: PHP binary not found at ${PHP_BIN}` };
    }

    try {
        const modules = execFileSync(PHP_BIN, ['-m'], { encoding: 'utf8' });
        if (!/^soap$/im.test(modules)) {
            return { available: false, message: 'skipped: PHP SOAP extension is not loaded' };
        }
    } catch (error) {
        return { available: false, message: `skipped: failed to inspect PHP modules (${String(error)})` };
    }

    return { available: true, message: `using ${PHP_BIN}` };
}

function runPhpSoapServer(request: string, setup: string): { status: number | null; output: string } {
    const script = `
    ${setup}
    $request = stream_get_contents(STDIN);
    ob_start();
    $server->handle($request);
    $response = ob_get_clean();
    echo $response;
  `;

    const result = spawnSync(PHP_BIN, ['-d', 'soap.wsdl_cache_enabled=0', '-r', script], {
        input: request,
        encoding: 'utf8',
        env: { ...process.env },
    });

    return {
        status: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
}
