// ── Cloudflare Worker 环境绑定 ────────────────────────────────────
// Queue 消息体：Cron 规则触发后投入，Consumer 消费
export interface CronMessageJob {
  rule_id: number;          // D1 cron_rules.id
  connection_id: string;
  chat_id: number;
  text: string;
  parse_mode: string;
  reply_markup: string | null;
  fired_at: number;         // 本次应触发的时间戳（用于日志）
}

// DB 行类型
export interface DBCronRule {
  id: number;
  name: string;
  connection_id: string;
  chat_id: number;
  text: string;
  parse_mode: string;
  reply_markup: string | null;
  cron_expr: string;
  timezone: string;
  enabled: number;
  last_run: number | null;
  next_run: number | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

export interface Env {
  BOT_TOKEN: string;
  ACCESS_PASSWORD: string;
  WEBHOOK_SECRET: string;
  ALLOWED_BUSINESS_CONNECTION_IDS: string;
  DB: D1Database;
  QUEUE: Queue<CronMessageJob>;
}

// ── Telegram Bot API 10.0 BusinessBotRights（严格对齐官方文档）────
// https://core.telegram.org/bots/api#businessbotrights
export interface BusinessBotRights {
  // 消息管理
  can_reply?: boolean;              // 可在最近 24h 有来信的私聊中发送/编辑消息
  can_read_messages?: boolean;      // 可将来信标记为已读
  can_delete_sent_messages?: boolean; // 可删除 Bot 自己发的消息
  can_delete_all_messages?: boolean;  // 可删除管理聊天的所有私信
  // 资料管理
  can_edit_name?: boolean;
  can_edit_bio?: boolean;
  can_edit_profile_photo?: boolean;
  can_edit_username?: boolean;
  // 礼物与星星
  can_change_gift_settings?: boolean;
  can_view_gifts_and_stars?: boolean;
  can_convert_gifts_to_stars?: boolean;
  can_transfer_and_upgrade_gifts?: boolean;
  can_transfer_stars?: boolean;
  // 动态
  can_manage_stories?: boolean;
}

// ── Telegram 基础类型 ─────────────────────────────────────────────
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface BusinessConnection {
  id: string;
  user: TelegramUser;
  user_chat_id: number;
  date: number;
  rights?: BusinessBotRights;
  can_reply?: boolean; // deprecated since API 9.0，用 rights.can_reply 替代
  is_enabled: boolean;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  video?: { file_id: string; file_unique_id: string };
  document?: { file_id: string; file_unique_id: string; file_name?: string };
  audio?: { file_id: string; file_unique_id: string };
  voice?: { file_id: string; file_unique_id: string };
  sticker?: { file_id: string; file_unique_id: string; emoji?: string };
  animation?: { file_id: string; file_unique_id: string };
  business_connection_id?: string;
  reply_to_message?: TelegramMessage;
  entities?: any[];
  // Guest Mode (API 10.0)
  guest_query_id?: string;
  guest_bot_caller_user?: TelegramUser;
  guest_bot_caller_chat?: TelegramChat;
}

export interface DeletedBusinessMessages {
  business_connection_id: string;
  chat: TelegramChat;
  message_ids: number[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  business_connection?: BusinessConnection;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: DeletedBusinessMessages;
  guest_message?: TelegramMessage; // API 10.0 Guest Mode
}

// ── D1 数据库行类型 ───────────────────────────────────────────────
export interface DBConnection {
  id: string;
  user_id: number;
  user_chat_id: number;
  user_name: string | null;
  user_username: string | null;
  rights: string; // JSON string
  is_enabled: number;
  connected_at: number;
  updated_at: number;
}

export interface DBMessage {
  id: number;
  connection_id: string;
  chat_id: number;
  chat_title: string | null;
  message_id: number | null;
  from_user_id: number | null;
  from_name: string | null;
  direction: 'incoming' | 'outgoing';
  content_type: string;
  text: string | null;
  media_file_id: string | null;
  sent_at: number;
  is_deleted: number;
}

export interface DBRule {
  id: number;
  connection_id: string | null;
  trigger_type: 'keyword' | 'regex' | 'all';
  trigger_value: string | null;
  reply_text: string;
  reply_parse_mode: string;
  enabled: number;
  priority: number;
  created_at: number;
  updated_at: number;
}

export interface DBScheduledMessage {
  id: number;
  connection_id: string;
  chat_id: number;
  text: string;
  parse_mode: string | null;
  reply_markup: string | null;
  schedule_at: number;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  error_msg: string | null;
  created_at: number;
}

export interface DBLog {
  id: number;
  connection_id: string | null;
  action: string;
  detail: string | null;
  result: 'ok' | 'error';
  error_msg: string | null;
  created_at: number;
}
