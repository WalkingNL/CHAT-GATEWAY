export type ProjectRegistry = {
  projects?: Record<string, {
    on_demand?: {
      url?: string;
      token?: string;
      token_env?: string;
      window_spec_id?: string;
    };
    on_demand_url?: string;
    on_demand_token?: string;
    on_demand_token_env?: string;
    on_demand_window_spec_id?: string;
    notify?: {
      telegram_chat_ids?: Array<string | number>;
      feishu_chat_ids?: Array<string | number>;
      overrides?: any;
      target_overrides?: any;
    };
    notify_overrides?: any;
  }>;
};
