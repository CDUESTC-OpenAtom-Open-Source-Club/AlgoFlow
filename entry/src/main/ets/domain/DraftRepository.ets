import { Draft } from './Models';

export interface DraftRepository {
  initialize(): Promise<void>;
  list(): Draft[];
  get(id: string): Draft | undefined;
  save(draft: Draft): void;
  delete(id: string): void;
  flush(): Promise<void>;
}
