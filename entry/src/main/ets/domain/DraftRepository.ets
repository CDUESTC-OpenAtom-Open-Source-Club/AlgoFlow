import { Draft, DraftVersion, Notification, NotificationKind } from './Models';

export interface DraftRepository {
  initialize(): Promise<void>;
  list(): Draft[];
  listAll(): Draft[];
  listArchived(): Draft[];
  get(id: string): Draft | undefined;
  save(draft: Draft): void;
  delete(id: string): void;
  flush(): Promise<void>;
  listVersions(draftId: string): DraftVersion[];
  listAllVersions(): DraftVersion[];
  totalVersionCount(): number;
  listNotifications(): Notification[];
  recordNotification(kind: NotificationKind, title: string, message: string): void;
  markNotificationRead(id: string): void;
  markAllNotificationsRead(): void;
  unreadNotificationCount(): number;
}
