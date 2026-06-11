import type { SoapFaultOptions, SoapVersion } from './types.js';

export class SoapFault extends Error {
    readonly faultcode: string;
    readonly faultstring: string;
    readonly faultactor?: string;
    readonly detail?: unknown;
    readonly faultname?: string;
    readonly status: number;
    readonly soapVersion?: SoapVersion;

    constructor(code: string, message: string, options: Omit<SoapFaultOptions, 'code' | 'message'> = {}) {
        super(message);
        this.name = 'SoapFault';
        this.faultcode = code;
        this.faultstring = message;
        if (options.actor !== undefined) {
            this.faultactor = options.actor;
        }
        if (options.detail !== undefined) {
            this.detail = options.detail;
        }
        if (options.name !== undefined) {
            this.faultname = options.name;
        }
        this.status = options.status ?? 500;
        if (options.soapVersion !== undefined) {
            this.soapVersion = options.soapVersion;
        }
    }
}

export class UnsupportedSoapFeatureError extends Error {
    constructor(feature: string) {
        super(`${feature} is not implemented by soap-server-ts`);
        this.name = 'UnsupportedSoapFeatureError';
    }
}

export function isSoapFault(value: unknown): value is SoapFault {
    return value instanceof SoapFault;
}

export function toSoapFault(
    error: unknown,
    options: { exposeStackTraces: boolean; soapVersion: SoapVersion },
): SoapFault {
    if (isSoapFault(error)) {
        return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const detail = options.exposeStackTraces && error instanceof Error ? { stack: error.stack ?? '' } : undefined;
    return new SoapFault('Server', message || 'Internal SOAP server error', {
        detail,
        soapVersion: options.soapVersion,
        status: 500,
    });
}

export function mapFaultCodeForVersion(code: string, version: SoapVersion): string {
    const localCode = code.includes(':') ? (code.split(':').pop() ?? code) : code;

    if (version === '1.1') {
        if (localCode === 'Sender') {
            return 'SOAP-ENV:Client';
        }
        if (localCode === 'Receiver') {
            return 'SOAP-ENV:Server';
        }
        if (localCode === 'MustUnderstand') {
            return 'SOAP-ENV:MustUnderstand';
        }
        if (localCode === 'VersionMismatch') {
            return 'SOAP-ENV:VersionMismatch';
        }
        if (localCode === 'Client' || localCode === 'Server') {
            return `SOAP-ENV:${localCode}`;
        }
        return localCode;
    }

    if (localCode === 'Client') {
        return 'env:Sender';
    }
    if (localCode === 'Server') {
        return 'env:Receiver';
    }
    if (localCode === 'MustUnderstand') {
        return 'env:MustUnderstand';
    }
    if (localCode === 'VersionMismatch') {
        return 'env:VersionMismatch';
    }
    if (localCode === 'Sender' || localCode === 'Receiver') {
        return `env:${localCode}`;
    }
    return localCode;
}
