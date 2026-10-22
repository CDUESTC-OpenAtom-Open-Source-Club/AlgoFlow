import router from '@ohos.router';

export const HOME_ROUTE: string = 'pages/Home';
export const EDITOR_ROUTE: string = 'pages/Index';
export const PLACEHOLDER_ROUTE: string = 'pages/Placeholder';

export const PLACEHOLDER_TITLE_KEY: string = 'placeholderTitle';
export const PLACEHOLDER_DETAIL_KEY: string = 'placeholderDetail';

// Service card launches are delivered to Home through this AppStorage key. The
// value carries a nonce so a repeated tap on the same card still triggers @Watch.
export const CARD_REQUEST_KEY: string = 'cardRequest';

export enum CardAction {
  NONE = 'none',
  OPEN_HOME = 'open_home',
  OPEN_DRAFT = 'open_draft',
  NEW_DRAFT = 'new_draft'
}

export class CardRequest {
  action: CardAction = CardAction.NONE;
  draftId: string = '';
  nonce: string = '';
}

class CardRequestBody {
  action: string = '';
  draft_id: string = '';
  nonce: string = '';
}

// Reads FormLink router params from Want.parameters. Params may arrive as
// top-level keys or as a JSON string under `params`; both are accepted. Cards
// added before `card_action` existed only send `draft_id`.
export function parseCardLaunch(parameters: Record<string, Object> | undefined, nonce: string): CardRequest {
  const request = new CardRequest();
  request.nonce = nonce;
  if (parameters === undefined) return request;
  let values: Record<string, Object> = parameters;
  const nested = parameters['params'];
  if (typeof nested === 'string') {
    try { values = JSON.parse(nested) as Record<string, Object>; } catch (error) { return request; }
  }
  const action = typeof values['card_action'] === 'string' ? values['card_action'] as string : '';
  const draftId = typeof values['draft_id'] === 'string' ? (values['draft_id'] as string).trim() : '';
  if (action === CardAction.NEW_DRAFT) {
    request.action = CardAction.NEW_DRAFT;
  } else if (action === CardAction.OPEN_HOME || draftId === 'latest') {
    request.action = CardAction.OPEN_HOME;
  } else if (draftId.length > 0) {
    request.action = CardAction.OPEN_DRAFT;
    request.draftId = draftId;
  } else if (action === CardAction.OPEN_DRAFT) {
    request.action = CardAction.OPEN_HOME;
  }
  return request;
}

export function encodeCardRequest(request: CardRequest): string {
  if (request.action === CardAction.NONE) return '';
  const body = new CardRequestBody();
  body.action = request.action;
  body.draft_id = request.draftId;
  body.nonce = request.nonce;
  return JSON.stringify(body);
}

export function decodeCardRequest(value: string | undefined): CardRequest {
  const request = new CardRequest();
  if (value === undefined || value.length === 0) return request;
  let body: CardRequestBody;
  try { body = JSON.parse(value) as CardRequestBody; } catch (error) { return request; }
  if (body.action === CardAction.NEW_DRAFT) request.action = CardAction.NEW_DRAFT;
  else if (body.action === CardAction.OPEN_HOME) request.action = CardAction.OPEN_HOME;
  else if (body.action === CardAction.OPEN_DRAFT && typeof body.draft_id === 'string' && body.draft_id.length > 0) {
    request.action = CardAction.OPEN_DRAFT;
    request.draftId = body.draft_id;
  }
  request.nonce = typeof body.nonce === 'string' ? body.nonce : '';
  return request;
}

export async function openEditor(draftId: string): Promise<void> {
  AppStorage.setOrCreate<string>('routeDraftId', draftId);
  await router.pushUrl({ url: EDITOR_ROUTE });
}

export async function openHome(): Promise<void> {
  await router.pushUrl({ url: HOME_ROUTE });
}

export async function openPlaceholder(title: string, detail: string): Promise<void> {
  AppStorage.setOrCreate<string>(PLACEHOLDER_TITLE_KEY, title);
  AppStorage.setOrCreate<string>(PLACEHOLDER_DETAIL_KEY, detail);
  await router.pushUrl({ url: PLACEHOLDER_ROUTE });
}

export async function goBack(): Promise<void> {
  await router.back();
}
