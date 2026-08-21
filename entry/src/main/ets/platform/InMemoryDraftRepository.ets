import { DraftRepository } from '../domain/DraftRepository';
import { Draft } from '../domain/Models';

// Starter adapter only. Replace with an API 20 relational-store adapter before persistence acceptance.
export class InMemoryDraftRepository implements DraftRepository {
  private drafts: Draft[] = [];

  list(): Draft[] {
    return this.drafts.filter((draft: Draft) => !draft.deleted);
  }

  get(id: string): Draft | undefined {
    return this.drafts.find((draft: Draft) => draft.id === id && !draft.deleted);
  }

  save(draft: Draft): void {
    const index = this.drafts.findIndex((item: Draft) => item.id === draft.id);
    if (index >= 0) {
      this.drafts[index] = draft;
    } else {
      this.drafts.push(draft);
    }
  }

  delete(id: string): void {
    const draft = this.get(id);
    if (draft !== undefined) {
      draft.deleted = true;
      draft.updatedAt = new Date().toISOString();
    }
  }
}
