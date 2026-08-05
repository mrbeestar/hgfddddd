// In-memory state machine for admin conversation flows

export type AdminState =
  | { type: "idle" }
  | { type: "broadcast_wait_type" }
  | { type: "broadcast_wait_content" }
  | { type: "broadcast_wait_caption"; msgType: string; content: string; contentEntities?: string; captionEntities?: string; forwardData?: string }
  | { type: "broadcast_confirm"; msgType: string; content: string; caption?: string; contentEntities?: string; captionEntities?: string; forwardData?: string; inlineButtons?: string }
  | { type: "broadcast_wait_inline"; msgType: string; content: string; caption?: string; contentEntities?: string; captionEntities?: string; forwardData?: string }
  | { type: "button_wait_label" }
  | { type: "button_wait_sub_label"; parentId: number }
  | { type: "button_wait_row"; buttonId: number; label: string }
  | { type: "button_manage"; buttonId: number }
  | { type: "button_set_row"; buttonId: number }
  | { type: "button_set_autodelete"; buttonId: number }
  | { type: "button_msg_wait_content"; buttonId: number }
  | { type: "button_msg_wait_caption"; buttonId: number; msgType: string; content: string; contentEntities?: string; captionEntities?: string; forwardData?: string }
  | { type: "button_msg_wait_inline"; buttonId: number; msgType: string; content: string; caption?: string; contentEntities?: string; captionEntities?: string; forwardData?: string }
  | { type: "button_msg_edit_wait_content"; buttonId: number; msgId: number }
  | { type: "button_msg_edit_wait_caption"; buttonId: number; msgId: number; msgType: string; content: string }
  | { type: "button_msg_edit_wait_inline"; buttonId: number; msgId: number; msgType: string; content: string; caption?: string }
  | { type: "channel_wait_id" }
  | { type: "channel_wait_name"; channelId: string }
  | { type: "channel_wait_url"; channelId: string; channelName: string }
  | { type: "setting_wait_value"; key: string; label: string }
  | { type: "button_msg_edit_wait_media_group"; buttonId: number; msgId: number }
  | { type: "command_wait_name" }
  | { type: "command_msg_wait_content"; commandId: number }
  | { type: "command_msg_wait_inline"; commandId: number; msgType: string; content: string; caption?: string; contentEntities?: string; captionEntities?: string; forwardData?: string }
  | { type: "command_msg_edit_wait_content"; commandId: number; msgId: number }
  | { type: "command_msg_edit_wait_inline"; commandId: number; msgId: number; msgType: string; content: string; caption?: string }
  | { type: "broadcast_wait_media_group" }
  | { type: "user_search" }
  | { type: "user_ban_wait" }
  | { type: "user_unban_wait" }
  | { type: "users_list"; page: number }
  | { type: "banned_list"; page: number };

const states = new Map<number, AdminState>();

export function getState(adminId: number): AdminState {
  return states.get(adminId) ?? { type: "idle" };
}

export function setState(adminId: number, state: AdminState) {
  states.set(adminId, state);
}

export function resetState(adminId: number) {
  states.set(adminId, { type: "idle" });
}
