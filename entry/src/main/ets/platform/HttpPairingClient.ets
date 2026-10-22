import http from '@ohos.net.http';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PairingClaim, PairingError, PairingErrorCode, PairingInvitation, parsePairingClaim } from '../domain/PairingContract';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';

class PairingClaimBody {
  code: string;
  phone_client_id: string;

  constructor(code: string, phoneClientId: string) {
    this.code = code;
    this.phone_client_id = phoneClientId;
  }
}

// Claims a pairing code at the desktop's sync-api (POST /v1/pairing/claims).
// The code is never logged.
export class HttpPairingClient {
  async claim(invitation: PairingInvitation, phoneClientId: string): Promise<PairingClaim> {
    const request = http.createHttp();
    try {
      let response: http.HttpResponse;
      try {
        response = await request.request(`${invitation.syncApi}/v1/pairing/claims`, {
          method: http.RequestMethod.POST,
          header: { 'Content-Type': 'application/json' } as Record<string, string>,
          extraData: JSON.stringify(new PairingClaimBody(invitation.code, phoneClientId)),
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 5000,
          readTimeout: 10000
        });
      } catch (error) {
        hilog.error(DOMAIN, TAG, '[AlgoFlow] Pairing claim transport failed.');
        throw new PairingError(PairingErrorCode.NETWORK);
      }
      const body = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      try {
        const claim = parsePairingClaim(body);
        hilog.info(DOMAIN, TAG, '[AlgoFlow] Pairing claimed. http_status=%{public}s', response.responseCode.toString());
        return claim;
      } catch (error) {
        const code = error instanceof PairingError ? error.code : PairingErrorCode.INVALID_RESPONSE;
        hilog.warn(DOMAIN, TAG, '[AlgoFlow] Pairing claim rejected. http_status=%{public}s error=%{public}s',
          response.responseCode.toString(), code);
        throw new PairingError(code);
      }
    } finally {
      request.destroy();
    }
  }
}
