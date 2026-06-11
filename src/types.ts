export type SoapVersion = '1.1' | '1.2';

export type SoapPrimitive = string | number | boolean | null;
export type SoapValue = SoapPrimitive | SoapStruct | SoapValue[];

export interface SoapStruct {
    [key: string]: SoapValue | undefined;
}

export interface SoapHeaderValue {
    name: string;
    namespaceURI: string | null;
    value: SoapValue;
    mustUnderstand: boolean;
    actor?: string;
}

export interface SoapRequestContext {
    request: Request;
    operationName: string;
    soapVersion: SoapVersion;
    soapAction?: string;
    headers: SoapHeaderValue[];
    namedParameters: Record<string, SoapValue>;
    wsdlOperation?: WsdlOperation;
}

export type SoapHandler = (...args: unknown[]) => unknown | Promise<unknown>;
export type SoapHandlerMap = Record<string, SoapHandler>;
export type SoapClassConstructor<T = object> = new (...args: unknown[]) => T;

export interface WsdlLoaderContext {
    url: string;
    request?: Request | undefined;
}

export type WsdlLoader = (context: WsdlLoaderContext) => Promise<string> | string;

export interface SoapServerOptions {
    uri?: string;
    soapVersion?: SoapVersion;
    encoding?: string;
    contentTypes?: string[];
    inferTypes?: boolean;
    exposeStackTraces?: boolean;
    returnWsdlOnGet?: boolean;
    wsdlLoader?: WsdlLoader;
    wsdlXml?: string;
    wsdlUrl?: string;
    cacheWsdl?: boolean;
    strictXsdValidation?: boolean;
    faultHttpStatus?: number;
    classmap?: Record<string, SoapClassConstructor>;
    typemap?: Record<string, unknown>;
    features?: number;
    actor?: string;
}

export interface SoapOperationRequest {
    operationName: string;
    namespaceURI: string | null;
    parameters: SoapValue[];
    namedParameters: Record<string, SoapValue>;
    headers: SoapHeaderValue[];
    soapVersion: SoapVersion;
}

export interface WsdlQName {
    rawName: string;
    localName: string;
    namespaceURI?: string;
}

export interface WsdlSchemaComponent {
    name: string;
    namespaceURI?: string;
    xml: string;
}

export interface WsdlSchema {
    targetNamespace?: string;
    xml: string;
    elements: Map<string, WsdlSchemaComponent>;
    types: Map<string, WsdlSchemaComponent>;
}

export interface WsdlPart {
    name: string;
    type?: string;
    element?: string;
    typeQName?: WsdlQName;
    elementQName?: WsdlQName;
}

export interface WsdlOperation {
    name: string;
    inputMessage?: string | undefined;
    outputMessage?: string | undefined;
    inputParts: WsdlPart[];
    outputParts: WsdlPart[];
    soapAction?: string | undefined;
    style?: 'rpc' | 'document' | undefined;
    use?: 'literal' | 'encoded' | undefined;
}

export interface WsdlMetadata {
    targetNamespace?: string;
    schemas: WsdlSchema[];
    operations: Map<string, WsdlOperation>;
    operationsBySoapAction: Map<string, WsdlOperation>;
    serviceLocation?: string;
    rawXml: string;
}

export interface SoapResponseOptions {
    operationName: string;
    resultName?: string;
    namespaceURI?: string;
    soapVersion: SoapVersion;
    value: unknown;
}

export interface SoapFaultOptions {
    code: string;
    message: string;
    actor?: string;
    detail?: unknown;
    name?: string;
    status?: number;
    soapVersion?: SoapVersion;
}

export interface OutgoingSoapHeader {
    name: string;
    namespaceURI?: string;
    value: unknown;
    mustUnderstand?: boolean;
    actor?: string;
}
