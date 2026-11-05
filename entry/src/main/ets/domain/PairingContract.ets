// Phone side of packages/contracts/schemas/sync.schema.json#/$defs/pairingInvitation
// and pairingClaimResult. The invitation only carries the sync-api address and a
// short-lived code; the device token and, when the deployment has one, the AI
// Gateway endpoint arrive in the server's claim result. Pairing is not account
// authentication.

export const PAIRING_INVITATION_TYPE: string = 'algoflow-pair-v1';
export const DEVICE_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;
const INVITATION_FIELDS: string[] = ['type', 'sync_api', 'code'];
const CODE_PATTERN: RegExp = /^[0-9]{8}$/;
const HTTPS_REQUIRED: string = '只能连接 https 地址的同步服务';
const HTTP_URL_PATTERN: RegExp = /^(https?):\/\/([^\/\s?#@]+)(\/[^\s?#]*)?$/;

export enum PairingRoute {
  LAN = 'lan',
  RELAY = 'relay'
}

export enum PairingErrorCode {
  INVALID_INVITATION = 'INVALID_INVITATION',
  INVALID_REQUEST = 'INVALID_REQUEST',
  PAIRING_CODE_INVALID = 'PAIRING_CODE_INVALID',
  PAIRING_CODE_EXPIRED = 'PAIRING_CODE_EXPIRED',
  PAIRING_CODE_USED = 'PAIRING_CODE_USED',
  PAIRING_RATE_LIMITED = 'PAIRING_RATE_LIMITED',
  NETWORK = 'NETWORK',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  TOKEN_STORAGE = 'TOKEN_STORAGE'
}

export class PairingInvitation {
  syncApi: string = '';
  code: string = '';
}

export class PairingInvitationParse {
  invitation?: PairingInvitation;
  error: string = '';
}

export class PairingClaim {
  pairingId: string = '';
  computerName: string = '';
  route: PairingRoute = PairingRoute.LAN;
  syncApi: string = '';
  aiGateway: string = '';
  // Only set when the server created a device for this phone. Never logged.
  deviceToken: string = '';
}

export class PairingError extends Error {
  code: PairingErrorCode;

  constructor(code: PairingErrorCode) {
    super(code);
    this.code = code;
  }
}

// Parses QR or pasted text. Every field is validated before anything is
// returned so a malformed invitation can never leave half-applied endpoints.
// Release builds pass httpsOnly: the device token and drafts must not travel
// in plain text.
export function parsePairingInvitation(text: string, httpsOnly: boolean = false): PairingInvitationParse {
  const result = new PairingInvitationParse();
  let parsed: Object | null = null;
  try {
    parsed = JSON.parse(text.trim()) as Object;
  } catch (error) {
    result.error = '不是算法随想的配对信息，请扫描或粘贴电脑端「手机远程」中的内容';
    return result;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.error = '不是算法随想的配对信息，请扫描或粘贴电脑端「手机远程」中的内容';
    return result;
  }
  const record = parsed as Record<string, Object>;
  if (Object.keys(record).some((key: string) => !INVITATION_FIELDS.includes(key)) ||
    record['type'] !== PAIRING_INVITATION_TYPE) {
    result.error = '配对信息版本不受支持（type 应为 algoflow-pair-v1）';
    return result;
  }
  const syncApi = typeof record['sync_api'] === 'string' ? record['sync_api'] as string : '';
  const code = typeof record['code'] === 'string' ? record['code'] as string : '';
  if (!isPairingEndpoint(syncApi)) {
    result.error = '配对信息中的 sync_api 必须是 http(s) 地址';
    return result;
  }
  if (httpsOnly && !syncApi.startsWith('https://')) {
    result.error = HTTPS_REQUIRED;
    return result;
  }
  if (!CODE_PATTERN.test(code)) {
    result.error = '配对信息中的配对码必须是 8 位数字';
    return result;
  }
  const invitation = new PairingInvitation();
  invitation.syncApi = trimSlash(syncApi);
  invitation.code = code;
  result.invitation = invitation;
  return result;
}

// Manual entry: the user types the server address and the 8-digit code. In
// Debug a bare host is a computer on the LAN and uses the default sync-api port
// 8787. With httpsOnly (release) it is the domain the web app is served from.
// An explicit URL is kept as is.
export function manualPairingInvitation(host: string, code: string, httpsOnly: boolean = false): PairingInvitationParse {
  const result = new PairingInvitationParse();
  const cleanCode = code.replace(/\s+/g, '');
  if (!CODE_PATTERN.test(cleanCode)) {
    result.error = '请输入电脑端「手机远程」窗口中的 8 位数字配对码';
    return result;
  }
  if (httpsOnly && host.trim().length === 0) {
    result.error = '请填写电脑上打开的网页地址中的域名';
    return result;
  }
  let value = host.trim().length > 0 ? host.trim() : '127.0.0.1';
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    if (httpsOnly) value = `https://${value}`;
    else value = /:\d+$/.test(value) ? `http://${value}` : `http://${value}:8787`;
  }
  if (!isPairingEndpoint(value)) {
    result.error = httpsOnly ? '服务器地址无效，请填写域名或完整的 https 地址' : '电脑地址无效，请填写 IP、IP:端口 或完整的 http(s) 地址';
    return result;
  }
  if (httpsOnly && !value.startsWith('https://')) {
    result.error = HTTPS_REQUIRED;
    return result;
  }
  const invitation = new PairingInvitation();
  invitation.syncApi = trimSlash(value);
  invitation.code = cleanCode;
  result.invitation = invitation;
  return result;
}

export function parsePairingClaim(body: string): PairingClaim {
  let record: Record<string, Object>;
  try {
    const parsed = JSON.parse(body) as Object;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    record = parsed as Record<string, Object>;
  } catch (error) {
    throw new PairingError(PairingErrorCode.INVALID_RESPONSE);
  }
  if (record['status'] !== 'claimed') throw new PairingError(pairingErrorCode(record['error_code']));
  const claim = new PairingClaim();
  claim.pairingId = typeof record['pairing_id'] === 'string' ? record['pairing_id'] as string : '';
  claim.computerName = typeof record['computer_name'] === 'string' ? record['computer_name'] as string : '';
  claim.route = record['route'] === PairingRoute.RELAY ? PairingRoute.RELAY : PairingRoute.LAN;
  claim.syncApi = typeof record['sync_api'] === 'string' ? record['sync_api'] as string : '';
  // A deployment without AI omits ai_gateway; a present one must still be valid.
  const hasAI = record['ai_gateway'] !== undefined;
  claim.aiGateway = typeof record['ai_gateway'] === 'string' ? record['ai_gateway'] as string : '';
  const hasToken = record['device_token'] !== undefined;
  claim.deviceToken = typeof record['device_token'] === 'string' ? record['device_token'] as string : '';
  if (claim.pairingId.length === 0 || !isPairingEndpoint(claim.syncApi) || (hasAI && !isPairingEndpoint(claim.aiGateway)) ||
    (hasToken && !DEVICE_TOKEN_PATTERN.test(claim.deviceToken))) {
    throw new PairingError(PairingErrorCode.INVALID_RESPONSE);
  }
  claim.syncApi = trimSlash(claim.syncApi);
  claim.aiGateway = trimSlash(claim.aiGateway);
  return claim;
}

export function pairingErrorCode(value: Object | undefined): PairingErrorCode {
  if (value === PairingErrorCode.INVALID_REQUEST) return PairingErrorCode.INVALID_REQUEST;
  if (value === PairingErrorCode.PAIRING_CODE_INVALID) return PairingErrorCode.PAIRING_CODE_INVALID;
  if (value === PairingErrorCode.PAIRING_CODE_EXPIRED) return PairingErrorCode.PAIRING_CODE_EXPIRED;
  if (value === PairingErrorCode.PAIRING_CODE_USED) return PairingErrorCode.PAIRING_CODE_USED;
  if (value === PairingErrorCode.PAIRING_RATE_LIMITED) return PairingErrorCode.PAIRING_RATE_LIMITED;
  return PairingErrorCode.INVALID_RESPONSE;
}

// The desktop advertises endpoints as it sees them. A loopback address on the
// desktop is not the desktop from the phone's point of view, so it is rewritten
// to the host the phone actually reached. The sync-api the phone reached always
// wins over the advertised one.
export function resolvePairingEndpoints(reachedSyncApi: string, claim: PairingClaim): string[] {
  const reached = HTTP_URL_PATTERN.exec(reachedSyncApi);
  const advertised = claim.aiGateway.length > 0 ? HTTP_URL_PATTERN.exec(claim.aiGateway) : null;
  let aiGateway = claim.aiGateway;
  if (reached !== null && advertised !== null && isLoopbackHost(hostOf(advertised[2])) && !isLoopbackHost(hostOf(reached[2]))) {
    const port = portOf(advertised[2]);
    aiGateway = `${advertised[1]}://${hostOf(reached[2])}${port}${advertised[3] ?? ''}`;
  }
  return [trimSlash(reachedSyncApi), trimSlash(aiGateway)];
}

// Shown before the claim, so the user sees where the drafts will go before
// anything leaves the phone. Only the authority is shown: it is the part a
// phishing code would have to fake.
export function pairingConsentMessage(syncApi: string): string {
  const server = serverAuthority(syncApi);
  const plain = syncApi.startsWith('http://') ? '\n\n这是未加密的 http 连接，只应在调试时使用。' : '';
  return `服务器：${server}\n\n连接后，这台手机的草稿会上传到这台服务器，扫码的那台电脑可以读取和修改已同步的草稿。请只在信任这台服务器和这台电脑时继续。${plain}`;
}

// host[:port] of an http(s) address, for showing which server the phone uses.
export function serverAuthority(url: string): string {
  const match = HTTP_URL_PATTERN.exec(url);
  return match !== null ? match[2] : url;
}

// lanHints adds the Debug-only advice about LAN addresses and hdc port forwarding.
export function pairingErrorMessage(code: PairingErrorCode, lanHints: boolean = true): string {
  if (code === PairingErrorCode.PAIRING_CODE_INVALID) return '配对码不正确，请核对电脑端显示的 8 位数字';
  if (code === PairingErrorCode.PAIRING_CODE_EXPIRED) return '配对码已过期，请在电脑端刷新配对码后重试';
  if (code === PairingErrorCode.PAIRING_CODE_USED) return '配对码已被使用，请在电脑端刷新配对码';
  if (code === PairingErrorCode.PAIRING_RATE_LIMITED) return '尝试次数过多，请 1 分钟后再试';
  if (code === PairingErrorCode.NETWORK) {
    return lanHints ? '无法连接电脑的同步服务，请确认地址、同一局域网或 hdc rport 转发' : '无法连接同步服务，请检查网络和服务器地址后重试';
  }
  if (code === PairingErrorCode.INVALID_REQUEST) return '配对请求格式无效';
  if (code === PairingErrorCode.TOKEN_STORAGE) return '无法在本机保存设备令牌，未完成配对，请重试';
  return '电脑端返回的配对结果无效，请确认双方版本一致';
}

export function isPairingEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  const match = HTTP_URL_PATTERN.exec(value);
  if (match === null) return false;
  const host = hostOf(match[2]);
  const port = portOf(match[2]);
  return host.length > 0 && (port.length === 0 || /^:[0-9]{1,5}$/.test(port));
}

function hostOf(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end > 0 ? authority.substring(0, end + 1) : '';
  }
  const colon = authority.indexOf(':');
  return colon >= 0 ? authority.substring(0, colon) : authority;
}

function portOf(authority: string): string {
  const host = hostOf(authority);
  return authority.substring(host.length);
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.substring(0, value.length - 1) : value;
}
