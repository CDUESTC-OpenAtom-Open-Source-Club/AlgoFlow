import http from '@ohos.net.http';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PullResult, PushResult, SyncEntityType, SyncOperation, SyncOperationType } from '../domain/SyncModels';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';

export class HttpSyncClient {
  private baseUrl: string;
  private authToken: string;

  constructor(baseUrl: string, authToken: string = '') {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.authToken = authToken;
  }

  async push(operation: SyncOperation): Promise<PushResult> {
    const validationError = validateOperation(operation);
    if (validationError.length > 0) {
      hilog.error(DOMAIN, TAG,
        '[AlgoFlow] Sync contract rejected locally. operation_id=%{public}s reason=%{public}s',
        safeLogValue(operation.operation_id), validationError);
      throw new Error(`SYNC_CONTRACT_${validationError}`);
    }
    hilog.info(DOMAIN, TAG,
      '[AlgoFlow] Sync push started. operation_id=%{public}s entity_type=%{public}s base_version=%{public}s',
      safeLogValue(operation.operation_id), operation.entity_type, operation.base_version.toString());
    const body = JSON.stringify(new SyncOperationRequestBody(operation));
    const result = await this.request('/v1/sync/operations', http.RequestMethod.POST, body,
      safeLogValue(operation.operation_id));
    try {
      const parsed = JSON.parse(result.body) as PushResult;
      hilog.info(DOMAIN, TAG,
        '[AlgoFlow] Sync push completed. operation_id=%{public}s status=%{public}s http_status=%{public}s',
        safeLogValue(operation.operation_id), parsed.status, result.statusCode.toString());
      return parsed;
    } catch (error) {
      hilog.error(DOMAIN, TAG,
        '[AlgoFlow] Sync response JSON invalid. operation_id=%{public}s http_status=%{public}s',
        safeLogValue(operation.operation_id), result.statusCode.toString());
      throw new Error('SYNC_INVALID_RESPONSE');
    }
  }

  async pull(cursor: string): Promise<PullResult> {
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Sync pull started. cursor=%{public}s', safeLogValue(cursor));
    const result = await this.request(`/v1/sync/changes?after=${encodeURIComponent(cursor)}`,
      http.RequestMethod.GET, '', `cursor-${safeLogValue(cursor)}`);
    try {
      const parsed = JSON.parse(result.body) as PullResult;
      hilog.info(DOMAIN, TAG,
        '[AlgoFlow] Sync pull completed. changes=%{public}s next_cursor=%{public}s http_status=%{public}s',
        parsed.changes.length.toString(), safeLogValue(parsed.next_cursor), result.statusCode.toString());
      return parsed;
    } catch (error) {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Sync pull response JSON invalid. http_status=%{public}s',
        result.statusCode.toString());
      throw new Error('SYNC_INVALID_RESPONSE');
    }
  }

  private async request(path: string, method: http.RequestMethod, body: string,
    requestId: string): Promise<HttpResult> {
    const request = http.createHttp();
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.authToken.length > 0) headers.Authorization = `Bearer ${this.authToken}`;
      let response: http.HttpResponse;
      try {
        response = await request.request(`${this.baseUrl}${path}`, {
          method,
          header: headers,
          extraData: body,
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 5000,
          readTimeout: 10000
        });
      } catch (error) {
        const errorInfo = readTransportError(error as BusinessError);
        hilog.error(DOMAIN, TAG,
          '[AlgoFlow] Sync transport failed. request_id=%{public}s method=%{public}s path=%{public}s error_code=%{public}s cause=%{public}s',
          requestId, method.toString(), pathWithoutQuery(path), errorInfo.code, errorInfo.message);
        throw new Error(`SYNC_NETWORK_${errorInfo.code}`);
      }
      const responseBody = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      if (response.responseCode < 200 || response.responseCode >= 300) {
        if (response.responseCode === 409) return new HttpResult(response.responseCode, responseBody);
        const errorCode = readErrorCode(responseBody);
        hilog.error(DOMAIN, TAG,
          '[AlgoFlow] Sync HTTP rejected. request_id=%{public}s method=%{public}s path=%{public}s http_status=%{public}s error_code=%{public}s',
          requestId, method.toString(), pathWithoutQuery(path), response.responseCode.toString(), errorCode);
        throw new Error(`SYNC_HTTP_${response.responseCode}_${errorCode}`);
      }
      return new HttpResult(response.responseCode, responseBody);
    } finally {
      request.destroy();
    }
  }
}

class SyncOperationRequestBody {
  operation_id: string;
  entity_type: string;
  entity_id: string;
  operation_type: string;
  base_version: number;
  client_id: string;
  occurred_at: string;
  payload: Object;

  constructor(operation: SyncOperation) {
    this.operation_id = operation.operation_id;
    this.entity_type = operation.entity_type;
    this.entity_id = operation.entity_id;
    this.operation_type = operation.operation_type;
    this.base_version = operation.base_version;
    this.client_id = operation.client_id;
    this.occurred_at = operation.occurred_at;
    this.payload = operation.payload;
  }
}

class HttpResult {
  statusCode: number;
  body: string;

  constructor(statusCode: number, body: string) {
    this.statusCode = statusCode;
    this.body = body;
  }
}

class TransportErrorInfo {
  code: string;
  message: string;

  constructor(code: string, message: string) {
    this.code = code;
    this.message = message;
  }
}

function trimBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'http://127.0.0.1:8787';
  return trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
}

function validateOperation(operation: SyncOperation): string {
  if (operation.operation_id.trim().length === 0) return 'OPERATION_ID';
  if (operation.entity_id.trim().length === 0) return 'ENTITY_ID';
  if (operation.client_id.trim().length === 0) return 'CLIENT_ID';
  if (operation.entity_type !== SyncEntityType.DRAFT &&
    operation.entity_type !== SyncEntityType.CODE_DOCUMENT &&
    operation.entity_type !== SyncEntityType.AI_ARTIFACT) return 'ENTITY_TYPE';
  if (operation.operation_type !== SyncOperationType.UPSERT &&
    operation.operation_type !== SyncOperationType.DELETE) return 'OPERATION_TYPE';
  if (!Number.isInteger(operation.base_version) || operation.base_version < 0) return 'BASE_VERSION';
  if (!isUtcTimestamp(operation.occurred_at)) return 'OCCURRED_AT';
  if (operation.payload === undefined || operation.payload === null) return 'PAYLOAD';
  return '';
}

function isUtcTimestamp(value: string): boolean {
  return value.endsWith('Z') && !Number.isNaN(Date.parse(value));
}

function readErrorCode(body: string): string {
  try {
    const result = JSON.parse(body) as PushResult;
    if (result.error_code !== undefined && result.error_code.length > 0) return safeErrorCode(result.error_code);
  } catch (error) {
    return 'INVALID_RESPONSE';
  }
  return 'UNKNOWN';
}

function pathWithoutQuery(path: string): string {
  const queryIndex = path.indexOf('?');
  return queryIndex < 0 ? path : path.substring(0, queryIndex);
}

function safeLogValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').substring(0, 96);
}

function safeErrorCode(value: string): string {
  const sanitized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 64);
  return sanitized.length > 0 ? sanitized : 'UNKNOWN';
}

function readTransportError(error: BusinessError): TransportErrorInfo {
  const code = typeof error.code === 'number' ? error.code.toString() : 'UNKNOWN';
  const message = typeof error.message === 'string' ? safeLogValue(error.message) : 'unknown';
  return new TransportErrorInfo(safeErrorCode(code), message);
}
