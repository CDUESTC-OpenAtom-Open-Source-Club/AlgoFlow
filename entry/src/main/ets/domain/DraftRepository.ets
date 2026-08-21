import { Draft } from './Models';

export interface DraftRepository {
  list(): Draft[];
  get(id: string): Draft | undefined;
  save(draft: Draft): void;
  delete(id: string): void;
}
