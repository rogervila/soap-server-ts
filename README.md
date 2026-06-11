# soap-server-ts

`soap-server-ts` is a Fetch API-first TypeScript SOAP server library inspired by PHP's `SoapServer`. It is designed for Cloudflare Workers, Deno Deploy-style runtimes, modern edge/serverless environments, and any host where an application receives a standard Fetch API `Request` and returns a standard Fetch API `Response`.

The compatibility target is PHP's SOAP extension documentation, especially `SoapServer`, SOAP 1.1, SOAP 1.2, and WSDL 1.1. The project aims for maximum feasible compatibility, but compatibility is implemented in milestones and documented honestly. This package does not claim full PHP SOAP extension parity.

## Contents

- [Status](#status)
- [Goals And Non-Goals](#goals-and-non-goals)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Cloudflare Worker Example](#cloudflare-worker-example)
- [Hono Cloudflare Workers Example](#hono-cloudflare-workers-example)
- [PHP-Style API Example](#php-style-api-example)
- [WSDL Mode Example](#wsdl-mode-example)
- [Public API Reference](#public-api-reference)
- [Request Handling Semantics](#request-handling-semantics)
- [Serialization And Deserialization](#serialization-and-deserialization)
- [SOAP Faults](#soap-faults)
- [SOAP Headers](#soap-headers)
- [WSDL Support](#wsdl-support)
- [Runtime Compatibility](#runtime-compatibility)
- [PHP Compatibility Matrix](#php-compatibility-matrix)
- [Milestone Status](#milestone-status)
- [Testing](#testing)
- [CI And Publishing](#ci-and-publishing)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Architecture Notes](#architecture-notes)
- [License](#license)

## Status

Current package stage: early `0.x` library.

Implemented today:

- Fetch API `Request` to `Response` SOAP handling.
- SOAP 1.1 envelope/body parsing.
- SOAP 1.1 response envelope generation.
- Basic SOAP 1.2 envelope detection, response content type, and fault output.
- Dispatch to explicitly registered functions.
- Dispatch to object methods through `setObject()`.
- Dispatch to request-scoped class instances through `setClass()`.
- Basic scalar, object/struct, and array serialization/deserialization.
- SOAP fault generation for common error cases.
- SOAPAction parsing.
- SOAP request header parsing.
- Basic `mustUnderstand` behavior.
- Partial WSDL 1.1 metadata parsing for dispatch.
- HTTP `GET` WSDL response when configured.
- Optional black-box tests against a real PHP `SoapServer`.
- Worker bundle checks that scan published output for Node-only runtime imports.

Not yet complete:

- Full PHP SOAP extension parity.
- Full SOAP 1.2 behavior.
- Full WSDL 1.1 plus XML Schema validation.
- WSDL imports/includes.
- Complete document/literal wrapped handling.
- Complete rpc/encoded graph/reference handling.
- PHP `classmap`, `typemap`, and `features` behavior.
- PHP persistence modes.
- MTOM, attachments, WS-Security, and one-way operations.

## Goals And Non-Goals

Goals:

- Provide a PHP-inspired `SoapServer` API for TypeScript users.
- Keep the public runtime API serverless-friendly.
- Use standard Fetch API primitives: `Request`, `Response`, and `Headers`.
- Avoid Node.js runtime dependencies in the package entrypoint.
- Keep WSDL loading compatible with Workers by using strings, URLs, `fetch`, or user-provided loaders.
- Prefer explicit unsupported behavior over silent fallback behavior.
- Use SOAP faults for common request/dispatch/runtime errors.
- Document compatibility differences from PHP as carefully as implemented behavior.

Non-goals for the current stage:

- Running an HTTP server internally.
- Opening sockets or binding ports.
- Reading WSDL files from the local filesystem at runtime.
- Depending on Node built-ins such as `http`, `net`, `fs`, `stream`, `buffer`, or `crypto` in the runtime bundle.
- Matching PHP syntax exactly.
- Implementing every PHP SOAP option before the core serverless SOAP path is stable.

## Installation

```sh
pnpm add soap-server-ts
```

The package is ESM-first and also publishes a CommonJS build through package exports:

```json
{
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

Runtime dependency:

- `fast-xml-parser`
- `libxml2-wasm`

Development tooling in this repository:

- `pnpm`
- TypeScript
- Vitest
- tsup
- Biome
- optional PHP with the SOAP extension

## Quick Start

```ts
import { SoapServer } from 'soap-server-ts';

const server = new SoapServer(null, { uri: 'urn:calculator' });

server.addFunction('add', (a, b) => Number(a) + Number(b));

export default {
  fetch(request: Request): Promise<Response> {
    return server.handle(request);
  }
};
```

Example SOAP 1.1 request:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
  xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SOAP-ENV:Body>
    <ns1:add xmlns:ns1="urn:calculator">
      <a xsi:type="xsd:int">2</a>
      <b xsi:type="xsd:int">3</b>
    </ns1:add>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>
```

Representative response body:

```xml
<SOAP-ENV:Body>
  <ns1:addResponse xmlns:ns1="urn:calculator">
    <return xsi:type="xsd:int">5</return>
  </ns1:addResponse>
</SOAP-ENV:Body>
```

The full response includes the XML declaration and SOAP/XML Schema namespace declarations.

## Cloudflare Worker Example

```ts
import { SoapServer, createSoapFetchHandler } from 'soap-server-ts';

const server = new SoapServer(null, { uri: 'urn:example:hello' });

server.addFunction({
  hello(name) {
    return { greeting: `Hello, ${String(name)}` };
  }
});

export default {
  fetch: createSoapFetchHandler(server)
};
```

Worker notes:

- Module-level `SoapServer` construction is fine for immutable configuration.
- Prefer `setClass()` for request-scoped service state.
- Be careful with `setObject()` if the object mutates state, because isolates may be reused.
- Runtime WSDL loading should use inline XML, URL fetch, KV/R2-backed loaders, or another Fetch-compatible source.

## Hono Cloudflare Workers Example

`soap-server-ts` can be mounted inside a [Hono](https://hono.dev/) application because both Hono and this library use standard Fetch API primitives on Cloudflare Workers.

Install the application dependencies:

```sh
pnpm add hono soap-server-ts
pnpm add -D wrangler @cloudflare/workers-types
```

Example `src/index.ts`:

```ts
import { Hono } from 'hono';
import { SoapFault, SoapServer } from 'soap-server-ts';

const app = new Hono();

class CalculatorService {
  add(a: unknown, b: unknown): number {
    return Number(a) + Number(b);
  }

  divide(a: unknown, b: unknown): number {
    const divisor = Number(b);
    if (divisor === 0) {
      throw new SoapFault('Client', 'Division by zero');
    }
    return Number(a) / divisor;
  }
}

const soapServer = new SoapServer(null, { uri: 'urn:calculator' });
soapServer.setClass(CalculatorService);

app.get('/', (c) => c.text('SOAP endpoint: POST /soap'));

app.on(['GET', 'POST'], '/soap', (c) => soapServer.handle(c.req.raw));

export default app;
```

Minimal `wrangler.jsonc`:

```jsonc
{
  "name": "soap-server-hono-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-11"
}
```

Local development:

```sh
pnpm exec wrangler dev
```

Example request:

```sh
curl -X POST http://localhost:8787/soap \
  -H 'content-type: text/xml; charset=utf-8' \
  -H 'SOAPAction: "urn:calculator#add"' \
  --data '<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Body>
    <add><a>2</a><b>3</b></add>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>'
```

Hono integration notes:

- `c.req.raw` is the original Fetch API `Request`, so it can be passed directly to `SoapServer.handle()`.
- Use `app.on(['GET', 'POST'], '/soap', ...)` when you want the same route to handle SOAP `POST` requests and WSDL `GET` requests.
- Avoid middleware that consumes the request body before the SOAP route, because SOAP parsing needs to read the raw XML body.
- Authentication, rate limiting, logging, and tenant routing can be implemented as Hono middleware before the SOAP route as long as the XML body remains unread.

## PHP-Style API Example

```ts
import { SoapFault, SoapServer } from 'soap-server-ts';

class CalculatorService {
  add(a: unknown, b: unknown): number {
    return Number(a) + Number(b);
  }

  divide(a: unknown, b: unknown): number {
    const divisor = Number(b);
    if (divisor === 0) {
      throw new SoapFault('Client', 'Division by zero');
    }
    return Number(a) / divisor;
  }
}

const server = new SoapServer(null, { uri: 'urn:calculator' });
server.setClass(CalculatorService);

export const fetch = (request: Request) => server.handle(request);
```

Plain function registration is also supported:

```ts
const server = new SoapServer(null, { uri: 'urn:calculator' });

server.addFunction({
  add: (a, b) => Number(a) + Number(b),
  subtract: (a, b) => Number(a) - Number(b)
});
```

## WSDL Mode Example

Inline WSDL:

```ts
import { SoapServer } from 'soap-server-ts';

const wsdlXml = `<?xml version="1.0"?>
<wsdl:definitions
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="urn:calculator"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  targetNamespace="urn:calculator">
  <wsdl:message name="AddRequest">
    <wsdl:part name="a" type="xsd:int" />
    <wsdl:part name="b" type="xsd:int" />
  </wsdl:message>
  <wsdl:message name="AddResponse">
    <wsdl:part name="return" type="xsd:int" />
  </wsdl:message>
  <wsdl:portType name="CalculatorPortType">
    <wsdl:operation name="add">
      <wsdl:input message="tns:AddRequest" />
      <wsdl:output message="tns:AddResponse" />
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="CalculatorBinding" type="tns:CalculatorPortType">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http" />
    <wsdl:operation name="add">
      <soap:operation soapAction="urn:calculator#add" />
      <wsdl:input><soap:body use="encoded" namespace="urn:calculator" /></wsdl:input>
      <wsdl:output><soap:body use="encoded" namespace="urn:calculator" /></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
</wsdl:definitions>`;

const server = new SoapServer(wsdlXml);
server.addFunction('add', (a, b) => Number(a) + Number(b));
```

Serverless-safe WSDL URL loading:

```ts
const server = new SoapServer('https://example.com/calculator.wsdl', {
  wsdlLoader: async ({ url, request }) => {
    const response = await fetch(url, {
      headers: request ? { 'user-agent': request.headers.get('user-agent') ?? '' } : undefined
    });

    if (!response.ok) {
      throw new Error(`Could not load WSDL: ${response.status}`);
    }

    return response.text();
  }
});
```

When WSDL is configured and `returnWsdlOnGet` is true, HTTP `GET` returns the configured WSDL XML with `content-type: text/xml; charset=utf-8`.

## Public API Reference

### Exports

```ts
export { SoapServer, SOAP_FUNCTIONS_ALL, createSoapFetchHandler } from 'soap-server-ts';
export { SoapFault, UnsupportedSoapFeatureError, isSoapFault } from 'soap-server-ts';
export { parseSoapEnvelope, deserializeElement } from 'soap-server-ts';
export { serializeSoapFault, serializeSoapResponse } from 'soap-server-ts';
export { parseWsdl } from 'soap-server-ts';
```

Important exported types:

- `SoapServerOptions`
- `SoapHandler`
- `SoapHandlerMap`
- `SoapRequestContext`
- `SoapValue`
- `SoapStruct`
- `SoapVersion`
- `SoapHeaderValue`
- `OutgoingSoapHeader`
- `WsdlLoader`
- `WsdlMetadata`
- `WsdlOperation`
- `WsdlPart`

### `new SoapServer(wsdl, options)`

```ts
const server = new SoapServer(wsdlOrNull, options);
```

The first argument may be:

- `null` for non-WSDL mode.
- Inline WSDL XML.
- A WSDL URL string, usually paired with `wsdlLoader` or global `fetch`.

Constructor options:

| Option | Type | Default | Status | Description |
| --- | --- | --- | --- | --- |
| `uri` | `string` | `undefined` | Implemented | Default response namespace in non-WSDL mode. |
| `soapVersion` | `'1.1' \| '1.2'` | `'1.1'` | Partial | Default version for early faults and non-envelope decisions. |
| `encoding` | `string` | `'UTF-8'` | Partial | Option exists; responses currently emit UTF-8 XML. |
| `contentTypes` | `string[]` | common SOAP XML types | Implemented | Accepted request media types. |
| `inferTypes` | `boolean` | `true` | Implemented | Infers untyped numbers and booleans. |
| `exposeStackTraces` | `boolean` | `false` | Implemented | Includes JavaScript stack traces in fault detail when true. |
| `returnWsdlOnGet` | `boolean` | `true` | Implemented | Returns WSDL on GET when configured. |
| `wsdlLoader` | `WsdlLoader` | `undefined` | Implemented | Custom serverless-safe WSDL loader. |
| `wsdlXml` | `string` | `undefined` | Implemented | Explicit WSDL XML. |
| `wsdlUrl` | `string` | `undefined` | Implemented | Explicit WSDL URL. |
| `cacheWsdl` | `boolean` | `true` | Implemented | Caches parsed WSDL metadata per server instance. |
| `strictXsdValidation` | `boolean` | `false` | Implemented | Enables strict libxml2-backed structural XSD validation for inline document/literal global elements. Default remains PHP-compatible and validates present schema-typed values without failing on missing/extra elements PHP tolerates. |
| `faultHttpStatus` | `number` | `500` | Implemented | Default HTTP status for `server.fault()`. |
| `classmap` | `Record<string, Constructor>` | `undefined` | Unsupported | Accepted but not applied. |
| `typemap` | `Record<string, unknown>` | `undefined` | Unsupported | Accepted but not interpreted. |
| `features` | `number` | `undefined` | Unsupported | Accepted but not interpreted. |
| `actor` | `string` | `undefined` | Partial | Actor/role values can be parsed/emitted; full routing is not implemented. |

### `addFunction()`

```ts
server.addFunction('add', (a, b) => Number(a) + Number(b));

server.addFunction({
  add: (a, b) => Number(a) + Number(b),
  ping: () => 'pong'
});
```

Supported overloads:

```ts
addFunction(name: string, handler: SoapHandler): this;
addFunction(name: string): this;
addFunction(functions: SoapHandlerMap): this;
addFunction(functions: string[]): this;
addFunction(functions: typeof SOAP_FUNCTIONS_ALL): this;
```

Notes:

- Explicit handlers are recommended.
- `addFunction('name')` without a handler attempts `globalThis.name` and is provided only for API familiarity.
- `SOAP_FUNCTIONS_ALL` throws `UnsupportedSoapFeatureError` because global function discovery is not serverless-safe.

### `setClass()`

```ts
class Service {
  hello(name: unknown) {
    return `Hello, ${String(name)}`;
  }
}

server.setClass(Service);
```

Behavior:

- Dispatches operation names to class methods.
- Creates a fresh class instance per request.
- Reuses constructor arguments passed to `setClass(Ctor, ...args)`.

### `setObject()`

```ts
server.setObject({
  hello(name: unknown) {
    return `Hello, ${String(name)}`;
  }
});
```

Behavior:

- Dispatches operation names to object methods.
- Uses the object as `this`.
- Reuses the same object if the runtime reuses the module instance.

### `setPersistence()`

```ts
server.setPersistence('request');
```

Only request-scoped behavior is supported. Any non-request persistence mode throws `UnsupportedSoapFeatureError`.

### `handle()`

```ts
const response = await server.handle(request);
```

Behavior:

- Accepts a Fetch API `Request`.
- Returns a Fetch API `Response`.
- Handles `POST` SOAP requests.
- Handles `GET` WSDL responses when configured.
- Returns `405 Method Not Allowed` for methods other than `GET` and `POST`.
- Serializes SOAP faults for parse, dispatch, header, and handler errors.

### `handleXml()`

```ts
const xml = await server.handleXml(requestXml, {
  url: 'https://example.com/soap',
  headers: { SOAPAction: '"urn:calculator#add"' }
});
```

Convenience helper for tests and fixtures. It creates a synthetic `POST` request and returns the response body as a string.

### `fault()`

```ts
server.fault('Client', 'Invalid input');
```

Throws a `SoapFault` that `handle()` catches and serializes.

Signature:

```ts
fault(code: string, message: string, actor?: string, detail?: unknown, name?: string): never;
```

### `addSoapHeader()`

```ts
server.addSoapHeader('TraceId', 'abc-123', {
  namespaceURI: 'urn:example:headers',
  mustUnderstand: false
});
```

Adds SOAP header blocks to generated responses. This is partial PHP `addSoapHeader` compatibility, not full `SoapHeader` object parity.

### `getFunctions()`

Returns sorted operation names from explicit function registrations and discoverable object/class methods.

### `__getLastResponse()`

Returns the last generated SOAP response or fault XML for the current `SoapServer` instance.

### `createSoapFetchHandler()`

```ts
const handler = createSoapFetchHandler(server);
```

Returns `(request: Request) => Promise<Response>`.

### `SoapFault`

```ts
throw new SoapFault('Client', 'Invalid input', {
  detail: { field: 'amount' },
  status: 500,
  soapVersion: '1.1'
});
```

Constructor options:

```ts
{
  actor?: string;
  detail?: unknown;
  name?: string;
  status?: number;
  soapVersion?: '1.1' | '1.2';
}
```

Public fields:

- `faultcode`
- `faultstring`
- `faultactor`
- `detail`
- `faultname`
- `status`
- `soapVersion`

## Request Handling Semantics

### HTTP Methods

| Method | Behavior |
| --- | --- |
| `POST` | Parses and dispatches a SOAP request. |
| `GET` | Returns WSDL XML when configured and enabled. |
| Other methods | Returns `405 Method Not Allowed` with `Allow: GET, POST`. |

### Content Types

Accepted by default:

- `text/xml`
- `application/xml`
- `application/soap+xml`

The media type is compared before `; charset=...`, so `text/xml; charset=utf-8` is accepted.

Unsupported content types return a SOAP fault with HTTP status `415`.

### SOAP Version Detection

| Version | Envelope namespace |
| --- | --- |
| SOAP 1.1 | `http://schemas.xmlsoap.org/soap/envelope/` |
| SOAP 1.2 | `http://www.w3.org/2003/05/soap-envelope` |

SOAP version is primarily detected from the envelope namespace. `application/soap+xml` also influences the default fault version before the envelope is parsed.

### Dispatch Order

1. Parse XML.
2. Locate `Envelope` and `Body`.
3. Use the first non-`Fault` child of `Body` as the operation.
4. Deserialize positional parameters from operation children.
5. Deserialize named parameters from child local names.
6. If WSDL is configured, validate and reorder parameters by WSDL input parts where possible.
7. Process SOAP headers.
8. Dispatch to a function, object method, or class method.
9. Serialize a response or SOAP fault.

Dispatch target precedence:

1. `addFunction()` registrations.
2. `setObject()` methods.
3. `setClass()` methods.

## Serialization And Deserialization

### Input Mapping

| XML shape | TypeScript value |
| --- | --- |
| `xsi:nil="true"` or `xsi:nil="1"` | `null` |
| `xsi:type="xsd:string"` | `string` |
| integer-like XML Schema type | integer `number` |
| `xsd:float`, `xsd:double`, `xsd:decimal` | `number` |
| `xsd:boolean` | `boolean` |
| element with children | object/struct |
| SOAP encoded array or repeated `item` children | array |
| duplicate child names | array under that property |

Integer-like types:

- `int`
- `integer`
- `long`
- `short`
- `byte`
- `nonNegativeInteger`
- `nonPositiveInteger`
- `positiveInteger`
- `negativeInteger`
- `unsignedInt`
- `unsignedLong`
- `unsignedShort`
- `unsignedByte`

Float-like types:

- `float`
- `double`
- `decimal`

When `inferTypes` is true, untyped scalar values such as `42`, `3.14`, `true`, and `false` are inferred as numbers and booleans. Set `inferTypes: false` to preserve untyped text.

### Output Mapping

| TypeScript value | SOAP XML shape |
| --- | --- |
| `string` | `xsi:type="xsd:string"` |
| integer `number` | `xsi:type="xsd:int"` |
| non-integer `number` | `xsi:type="xsd:double"` |
| `boolean` | `xsi:type="xsd:boolean"` |
| `null` or `undefined` | `xsi:nil="true"` |
| `Date` | `xsi:type="xsd:dateTime"` ISO string |
| array | `SOAP-ENC:arrayType="xsd:anyType[n]"` with `item` children |
| object | child elements for enumerable properties |

Invalid XML element names cause a server fault during serialization.

## SOAP Faults

Faults are generated for common errors:

- Malformed XML.
- Missing SOAP envelope.
- Unsupported SOAP envelope namespace.
- Missing SOAP body.
- Empty SOAP body.
- Unknown operation.
- Unsupported content type.
- Unhandled `mustUnderstand` header.
- Thrown `SoapFault`.
- Thrown JavaScript errors.
- Invalid XML element names during serialization.

SOAP 1.1 fault code mapping:

| Input code | Serialized code |
| --- | --- |
| `Client` | `SOAP-ENV:Client` |
| `Server` | `SOAP-ENV:Server` |
| `Sender` | `SOAP-ENV:Client` |
| `Receiver` | `SOAP-ENV:Server` |
| `MustUnderstand` | `SOAP-ENV:MustUnderstand` |
| `VersionMismatch` | `SOAP-ENV:VersionMismatch` |

SOAP 1.2 fault code mapping:

| Input code | Serialized code |
| --- | --- |
| `Client` | `env:Sender` |
| `Server` | `env:Receiver` |
| `Sender` | `env:Sender` |
| `Receiver` | `env:Receiver` |
| `MustUnderstand` | `env:MustUnderstand` |
| `VersionMismatch` | `env:VersionMismatch` |

Thrown non-`SoapFault` errors become `Server` faults. Stack traces are excluded unless `exposeStackTraces: true` is set.

## SOAP Headers

Request headers are parsed before the body operation.

If a service function or method exists with the same local name as a header block, that method is invoked with the parsed header value:

```xml
<SOAP-ENV:Header>
  <Auth SOAP-ENV:mustUnderstand="1">
    <token>secret</token>
  </Auth>
</SOAP-ENV:Header>
```

```ts
server.setObject({
  Auth(header) {
    // header is { token: 'secret' }
  },
  add(a, b) {
    return Number(a) + Number(b);
  }
});
```

If a header has `mustUnderstand="1"` or `mustUnderstand="true"` and no matching handler exists, the server returns a `MustUnderstand` SOAP fault.

Current limitations:

- Header actor/role is parsed and can be emitted.
- Full SOAP intermediary/role routing semantics are not implemented.
- PHP `SoapHeader` object parity is not implemented.

## WSDL Support

WSDL support is intentionally partial and focused on dispatch metadata.

Parsed WSDL 1.1 constructs:

- `definitions`
- `targetNamespace`
- `message`
- `part`
- `portType`
- `operation`
- `input`
- `output`
- `binding`
- SOAP binding style
- SOAP operation `soapAction`
- SOAP body `use`
- `service`
- SOAP service `address location`

Used at runtime:

- Validate that a request operation exists in the WSDL.
- Look up operations by SOAPAction where available.
- Reorder request parameters according to WSDL input parts.
- Validate common scalar WSDL input part types such as `xsd:int`, `xsd:float`, `xsd:double`, `xsd:decimal`, `xsd:boolean`, and `xsd:string`.
- Validate inline XSD global elements used by document/literal WSDL parts through `libxml2-wasm`.
- By default, match observed PHP `SoapServer` behavior: validate present schema-typed values, but do not reject missing required children or unexpected extra children that PHP tolerates.
- When `strictXsdValidation: true`, run strict libxml2 structural validation for inline document/literal global elements.
- Use the first WSDL output part name as the response result element name.
- Use the WSDL `targetNamespace` as the response namespace.
- Missing rpc/encoded input parts currently become `null`, which matches observed PHP `SoapServer` behavior for the calculator fixture.

Not implemented:

- WSDL imports/includes.
- Full XML Schema import/include resolution.
- Complex type mapping.
- Full document/literal wrapped behavior.
- Full rpc/encoded graph/reference behavior.
- WSDL 2.0.
- WSDL generation from TypeScript classes.

### `parseWsdl()`

```ts
import { parseWsdl } from 'soap-server-ts';

const metadata = parseWsdl(wsdlXml);

console.log(metadata.targetNamespace);
console.log(metadata.serviceLocation);
console.log([...metadata.operations.keys()]);
```

`parseWsdl()` is exported for tests, diagnostics, and advanced integrations.

## Runtime Compatibility

The runtime path uses APIs available in Workers and browser-like runtimes:

- `Request`
- `Response`
- `Headers`
- `fetch`
- `Promise`
- strings and plain JavaScript objects

The runtime package entrypoint does not import Node-only modules such as:

- `http`
- `net`
- `fs`
- `stream`
- `buffer`
- `crypto`
- `path`
- `os`
- `child_process`

The repository includes `scripts/check-worker-bundle.mjs`, which builds the package and scans `dist/index.js` and `dist/index.cjs` for Node-only runtime imports.

Development-only scripts and tests may use Node APIs. For example, PHP compatibility tests use `node:child_process` to run PHP. Those files are not part of the runtime bundle.

## PHP Compatibility Matrix

| Area | Status | Notes |
| --- | --- | --- |
| Fetch API `Request`/`Response` handling | Implemented | Primary runtime API. |
| Long-lived HTTP server | Unsupported by design | Bring your own Fetch-compatible host. |
| SOAP 1.1 envelope parsing | Implemented | Namespace-aware parsing. |
| SOAP 1.1 response generation | Implemented | Generates SOAP 1.1 envelopes and typed result elements. |
| SOAP 1.1 faults | Implemented | Serializes common fault fields. |
| SOAP 1.2 envelope detection | Partial | SOAP 1.2 namespace is recognized. |
| SOAP 1.2 faults | Partial | Basic SOAP 1.2 fault output is implemented. |
| HTTP `POST` | Implemented | Parses and dispatches SOAP requests. |
| HTTP `GET` WSDL | Implemented | Returns configured WSDL. |
| Content-Type handling | Implemented | Accepts common SOAP media types. |
| SOAPAction | Partial | Parsed and used for WSDL lookup. |
| Scalar values | Implemented | Strings, numbers, booleans, and nil. |
| Struct values | Implemented | Child elements map to object properties. |
| Array values | Implemented | SOAP encoded arrays and common `item` arrays. |
| `addFunction` | Implemented with differences | Explicit handlers are supported. `SOAP_FUNCTIONS_ALL` is unsupported. |
| `setClass` | Implemented with differences | Fresh instance per request. |
| `setObject` | Implemented | Uses provided object. |
| `handle` | Implemented with differences | Takes Fetch `Request`; does not use PHP globals/stdout. |
| `fault` | Implemented | Throws `SoapFault`. |
| `SoapFault` | Partial | Common concept and fields only. |
| `addSoapHeader` | Partial | Emits response headers, not full PHP object parity. |
| Request SOAP headers | Partial | Parsed and dispatched by local name. |
| `mustUnderstand` | Partial | Faults when no matching handler exists. |
| WSDL 1.1 metadata | Partial | Dispatch metadata, common scalar input part validation, and inline schema metadata. |
| WSDL XML Schema validation | Partial | Default mode validates present schema-typed values like PHP `SoapServer`; `strictXsdValidation: true` uses `libxml2-wasm` for stricter inline document/literal global element validation. Full import/include resolution is not complete. |
| WSDL imports/includes | Unsupported | Single loaded WSDL XML only. |
| WSDL filesystem loading | Unsupported by design | Use inline XML, URL loading, or `wsdlLoader`. |
| WSDL 2.0 | Unsupported | Not implemented. |
| `classmap` | Unsupported | Option exists but is not applied. |
| `typemap` | Unsupported | Option exists but is not applied. |
| `features` | Unsupported | Option exists but is not interpreted. |
| `actor` / role | Partial | Values can be parsed/emitted; full routing is not implemented. |
| `uri` | Implemented | Used as default response namespace in non-WSDL mode. |
| `encoding` | Partial | UTF-8 output only at present. |
| Persistence | Unsupported except request mode | Persistent PHP object state is not serverless-safe. |
| One-way operations | Unsupported | No special one-way response behavior. |
| MTOM/attachments | Unsupported | Multipart SOAP is not parsed. |
| WS-Security | Unsupported | Can be built at app layer, but not built in. |

## Milestone Status

### Milestone 1: Core SOAP request handling

Status: implemented for SOAP 1.1 core behavior.

Implemented:

- SOAP 1.1 request parsing.
- SOAP envelope/body parsing.
- Operation dispatch.
- XML response generation.
- SOAP fault response generation.
- HTTP `POST` handling.
- Common SOAP 1.1 content types.
- Basic scalar, object/struct, and array handling.

### Milestone 2: PHP-like server API

Status: implemented with documented TypeScript/serverless differences.

Implemented:

- Constructor options.
- `addFunction`.
- `setClass`.
- `setObject`.
- `handle`.
- `fault` and thrown `SoapFault` behavior.

### Milestone 3: WSDL mode

Status: partially implemented.

Implemented:

- Inline WSDL XML.
- URL/custom loader WSDL loading.
- WSDL 1.1 operation/message/binding/service metadata parsing.
- WSDL operation validation.
- Inline XSD global element validation through `libxml2-wasm` for document/literal message parts.
- SOAPAction lookup.
- HTTP `GET` WSDL response.

### Milestone 4: SOAP versions, headers, and faults

Status: partially implemented.

Implemented:

- SOAP 1.2 namespace detection.
- SOAP 1.2 response content type.
- Basic SOAP 1.2 fault serialization.
- SOAPAction parsing.
- SOAP header parsing.
- Basic `mustUnderstand` behavior.

### Milestone 5: Advanced PHP compatibility

Status: mostly unsupported or partial.

Current status:

- `classmap`: unsupported.
- `typemap`: unsupported.
- `features`: unsupported.
- `actor`: partial.
- `uri`: implemented for response namespace behavior.
- `encoding`: partial.
- persistence: unsupported except request mode.
- one-way operations: unsupported.

## Testing

Normal test suite:

```sh
pnpm test
```

In this repository, when you want the optional PHP compatibility tests to use the local PHP binary explicitly, run:

```sh
PHP_BIN=/path/to/php pnpm test
```

Type checking:

```sh
pnpm run typecheck
```

Worker bundle check:

```sh
pnpm run check:worker
```

Full local verification:

```sh
pnpm run verify
```

Optional PHP compatibility test file only:

```sh
PHP_BIN=/path/to/php pnpm run test:php
```

Linting:

```sh
pnpm run lint
```

Formatting:

```sh
pnpm run format
```

The PHP tests use `PHP_BIN` when set, otherwise `php`. They skip when the binary or SOAP extension is unavailable.

Current test coverage includes:

- XML parsing.
- SOAP envelope parsing.
- Scalar, struct, and array handling.
- SOAP response serialization.
- SOAP fault serialization.
- Fetch API integration.
- Function, object, and class dispatch.
- Unknown method faults.
- Thrown fault handling.
- Unsupported content types.
- Unsupported HTTP methods.
- `mustUnderstand` behavior.
- SOAP 1.2 response basics.
- WSDL parsing and GET response.
- WSDL operation validation.
- WSDL loader abstraction.
- Optional PHP `SoapServer` comparison behavior.

## CI And Publishing

### CI

Workflow file: `.github/workflows/ci.yml`

Runs on every push and pull request.

CI uses:

- Node.js 20
- Node.js 22
- pnpm 9.15.0
- PHP 8.5 with the SOAP extension

CI steps:

1. Check out the repository.
2. Set up pnpm.
3. Set up Node.js with pnpm cache.
4. Set up PHP with the SOAP extension.
5. Run `pnpm install --frozen-lockfile`.
6. Run `pnpm run typecheck`.
7. Run `PHP_BIN="$(command -v php)" pnpm test`.
8. Run `pnpm run check:worker`.

### Publishing

Workflow file: `.github/workflows/publish.yml`

Runs when a tag is pushed matching `v*` or `[0-9]*`.

Accepted tags:

- `v1.2.3`
- `1.2.3`
- `v1.2.3-beta.1`
- `1.2.3-rc.0`

The workflow strips a leading `v`, validates semver, sets `package.json` to the tag version without creating a git tag, verifies the package, and publishes to npm.

Dist-tag behavior:

- Stable versions publish with `latest`.
- Prerelease versions publish with `next`.

Required repository secret:

- `NPM_TOKEN`, an npm automation token with permission to publish the package.

Publish command:

```sh
pnpm publish --access public --no-git-checks --tag "$DIST_TAG"
```

## Development

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Run tests with the local PHP binary:

```sh
PHP_BIN=/path/to/php pnpm test
```

Build the package:

```sh
pnpm run build
```

Run all standard verification:

```sh
pnpm run verify
```

Check production dependency vulnerabilities:

```sh
pnpm audit --prod
```

Project layout:

```text
src/
  envelope.ts      SOAP envelope parsing and value deserialization
  fault.ts         SoapFault and fault code mapping
  index.ts         Public exports
  serializer.ts    SOAP response and fault XML serialization
  soap-server.ts   PHP-inspired SoapServer facade and Fetch handler
  types.ts         Public types
  wsdl.ts          WSDL loading and metadata parsing
  xml.ts           fast-xml-parser wrapper with namespace-aware XML AST

tests/
  fixtures/        Golden SOAP/WSDL fixtures
  *.test.ts        Unit, integration, WSDL, and PHP compatibility tests

scripts/
  check-worker-bundle.mjs

.github/workflows/
  ci.yml
  publish.yml
```

Runtime bundle rule:

- Runtime code under `src/` must stay serverless-safe.
- Node-only APIs belong in `tests/`, `scripts/`, or build-time tooling.
- Run `pnpm run check:worker` after runtime dependency or bundling changes.

## Troubleshooting

### `Function "name" is not a valid method for this service`

The SOAP operation name did not match a registered function, object method, or class method.

Check:

- The local name of the first child inside `SOAP-ENV:Body`.
- The name passed to `addFunction()`.
- Method names on your object or class.
- WSDL operation names if WSDL mode is enabled.

### Unsupported SOAP Content-Type

The request media type is not in `contentTypes`.

Default accepted media types:

- `text/xml`
- `application/xml`
- `application/soap+xml`

To accept another media type:

```ts
new SoapServer(null, {
  contentTypes: ['text/xml', 'application/xml', 'application/soap+xml', 'application/custom+xml']
});
```

### `SOAP header "X" was not understood`

The request included a `mustUnderstand` header with no matching service method.

Add a method with the same local name as the header:

```ts
server.setObject({
  Auth(header) {
    // validate header
  },
  operation() {
    return 'ok';
  }
});
```

### WSDL is not returned on GET

Check:

- A WSDL string, `wsdlXml`, `wsdlUrl`, or `wsdlLoader` is configured.
- `returnWsdlOnGet` is not set to `false`.
- Your runtime routes `GET` requests to `server.handle()`.

### PHP compatibility tests are skipped

Run:

```sh
PHP_BIN=/path/to/php pnpm test
```

If tests still skip, check:

```sh
/path/to/php -m | grep -i '^soap$'
```

### Worker bundle check fails

Run:

```sh
pnpm run check:worker
```

Move Node-only usage to tests/scripts or replace it with Fetch/Web API-compatible code.

## Architecture Notes

### Why Fetch API first?

PHP `SoapServer::handle()` is tied to PHP's request input/output model. Serverless JavaScript runtimes use Fetch APIs instead. `soap-server-ts` keeps the PHP-inspired concepts but exposes them through `handle(request): Promise<Response>` so the same library can run in Workers, edge functions, service workers, tests, and adapters.

### Why `fast-xml-parser`?

SOAP parsing is on the request hot path. `fast-xml-parser` is small, fast, and Worker-compatible. It does not provide DOM namespace APIs, so this library wraps it with a namespace-aware AST that preserves element order, local names, prefixes, namespace URIs, attributes, children, and text.

### Why no filesystem WSDL loading?

Cloudflare Workers and many serverless runtimes do not expose a filesystem at runtime. Inline XML, URL loading, and custom `wsdlLoader` hooks cover the same use cases without tying the runtime bundle to Node.js.

### Why request-scoped `setClass()`?

PHP has persistence options because it runs under different process models. In Workers and similar runtimes, module instances may be reused across unrelated requests. Creating a fresh service class instance per request avoids accidental shared mutable state.

### Why document unsupported behavior so heavily?

SOAP compatibility bugs are often caused by silent assumptions. This project should prefer explicit unsupported behavior, clear faults, and documented limitations over broad catch-all behavior that looks compatible until it fails in production.

## License

MIT
