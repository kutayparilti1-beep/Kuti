import { Timestamp } from 'firebase/firestore';

export type AppTab = 'voice' | 'chat' | 'memory' | 'workspace' | 'admin';

export type BotRole = 'general' | 'deep_reasoning' | 'architect' | 'fast';

export interface ChatMessage {
  id: string;
  ownerId: string;
  role: 'user' | 'model';
  botRole: BotRole;
  text: string;
  createdAt?: Timestamp;
}

export type VoiceName = 'Zephyr' | 'Kore' | 'Puck' | 'Charon' | 'Fenrir';

export interface KnownFace {
  id: string;
  ownerId: string;
  name: string;
  relation: string;
  visualSignature: string;
  facialTraits: string[];
  learnedNotes: string;
  recognitionCount: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type MemoryCategory =
  | 'preference'
  | 'person_fact'
  | 'routine'
  | 'instruction'
  | 'workspace_note';

export interface LearnedMemory {
  id: string;
  ownerId: string;
  category: MemoryCategory;
  subject: string;
  content: string;
  source: 'voice' | 'vision' | 'workspace';
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AssistantTask {
  id: string;
  ownerId: string;
  title: string;
  summary: string;
  category: 'briefing' | 'email' | 'calendar' | 'drive' | 'analysis';
  status: 'pending' | 'completed';
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface UserNotification {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  source: 'voice' | 'gmail' | 'calendar' | 'system';
  read: boolean;
  createdAt?: Timestamp;
}

export interface UserRegistryItem {
  uid: string;
  email: string;
  createdAt?: Timestamp;
  lastSeenAt?: Timestamp;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  priority?: string;
  actionTip?: string;
}

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  htmlLink?: string;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

export type PendingMutationAction =
  | {
      type: 'send_email';
      to: string;
      subject: string;
      body: string;
      resolveToolCall?: (result: Record<string, unknown>) => void;
    }
  | {
      type: 'create_event';
      summary: string;
      startIso: string;
      endIso: string;
      description?: string;
      location?: string;
      resolveToolCall?: (result: Record<string, unknown>) => void;
    };
