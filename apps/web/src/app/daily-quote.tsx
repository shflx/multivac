import { DEFAULT_PREFERENCES } from '@multivac/contracts';
import { usePreferences } from '../features/preferences/use-preferences.js';

/** 第一版只有这一句话，每天固定显示，不随刷新或页面切换变化。 */
const DAILY_QUOTE = 'you can outsource your thinking, but you cannot outsource your understanding.';

export function DailyQuote() {
  const { preferences } = usePreferences();
  // 先读取已保存的开关，避免关闭后刷新时短暂显示句子。
  if (!preferences || !(preferences.showDailyQuote ?? DEFAULT_PREFERENCES.showDailyQuote)) return null;
  return <span className="shell-daily-quote" lang="en">{DAILY_QUOTE}</span>;
}
