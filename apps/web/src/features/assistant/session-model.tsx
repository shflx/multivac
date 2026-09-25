import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorThinkingLevel,
  type SessionModelOptions,
} from '@multivac/contracts';
import {
  getSessionModelCommand,
  getSessionModelOptions,
  setSessionModel,
} from '../../data/session-model-selection-api.js';

const REFRESH_INTERVAL_MS = 1_500;

const errors: Record<string, string> = {
  SELECTION_REVISION_CONFLICT: '选择已在其他位置更新，请核对当前模型后重试。',
  SESSION_RUNNING: '会话正在运行，暂不能修改模型或推理等级。',
  MODEL_UNAVAILABLE: '模型配置或认证当前不可用，请在管理页面修复。',
  THINKING_LEVEL_UNAVAILABLE: 'Pi 当前模型不支持该推理等级。',
  PI_SELECTION_FAILED: 'Pi 切换失败，已读取实际选择；不会自动重发。',
  SELECTION_STORAGE_FAILED: '选择保存失败或结果未知；请核对实际选择，不会自动重发。',
  SELECTION_INTERRUPTED: '上次切换中断，已核对实际选择；不会自动重发。',
};

function commandErrorMessage(code: string): string {
  return errors[code] ?? '切换未完成，请核对实际选择后重试。';
}

export type SessionModelChange = { profileId: string } | { thinkingLevel: CoordinatorThinkingLevel };

/** 发送门禁关心的选模状态。 */
export interface SessionModelState {
  available: boolean;
  busy: boolean;
  loaded: boolean;
}

export interface SessionModel extends SessionModelState {
  data: SessionModelOptions | null;
  error: string | null;
  readError: string | null;
  refresh(): Promise<void>;
  /** 提交选模命令；返回是否为成功切换了模型（调用方据此收起弹层）。 */
  change(value: SessionModelChange): Promise<boolean>;
  reportError(message: string): void;
}

/**
 * 会话选模控制器：轮询快照、提交命令并只读对账未知结果。
 *
 * 选模属于会话状态，每个会话只有一份；该会话的各呈现实例共享同一快照与在途命令。
 */
export function useSessionModelController(sessionId: string): SessionModel {
  const [data, setData] = useState<SessionModelOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const dataRef = useRef<SessionModelOptions | null>(null);
  const busyRef = useRef(false);
  const pending = useRef<string | null>(null);
  const changing = useRef(false);
  const reading = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);

  dataRef.current = data;
  busyRef.current = busy;

  const refresh = useCallback(async () => {
    if (changing.current || reading.current) return;
    reading.current = true;
    const request = ++generation.current;
    try {
      if (pending.current) {
        const result = await getSessionModelCommand(sessionId, pending.current);
        if (request !== generation.current || !mounted.current) return;
        if (result.status !== 'unknown') {
          pending.current = null;
          setBusy(false);
          setError(result.error ? commandErrorMessage(result.error) : null);
        }
      }
      const snapshot = await getSessionModelOptions(sessionId);
      if (request !== generation.current || !mounted.current) return;
      setData(snapshot);
      setReadError(null);
    } catch (cause) {
      if (request === generation.current && mounted.current) {
        setReadError(cause instanceof Error ? cause.message : '会话模型暂不可读取。');
      }
    } finally {
      reading.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const change = useCallback(async (value: SessionModelChange): Promise<boolean> => {
    const current = dataRef.current;
    if (!current || changing.current || busyRef.current || current.running) return false;
    const commandId = crypto.randomUUID();
    pending.current = commandId;
    changing.current = true;
    ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await setSessionModel({
        commandId,
        sessionId,
        revision: current.selection.revision,
        ...value,
      });
      setData((previous) => previous ? { ...previous, selection: result.selection } : previous);
      setError(result.error ? commandErrorMessage(result.error) : null);
      if (result.status !== 'unknown') {
        pending.current = null;
        setBusy(false);
      }
      return 'profileId' in value && result.status === 'succeeded' && !result.error;
    } catch {
      setError('切换结果未知，正在只读对账；不会自动重发命令。');
      return false;
    } finally {
      changing.current = false;
      void refresh();
    }
  }, [refresh, sessionId]);

  return {
    data,
    error,
    readError,
    busy,
    available: !readError && Boolean(data?.selection.availability.available),
    loaded: Boolean(data || readError),
    refresh,
    change,
    reportError: setError,
  };
}

/** 模型选择器所在呈现实例对应会话的选模状态。 */
export const SessionModelContext = createContext<SessionModel | null>(null);

/** 独立挂载模型选择器时使用（如视觉测试页）；应用内由会话宿主统一创建控制器。 */
export function SessionModelProvider({
  sessionId = GLOBAL_ASSISTANT_SESSION_ID,
  children,
}: { sessionId?: string; children: ReactNode }) {
  const model = useSessionModelController(sessionId);
  return <SessionModelContext.Provider value={model}>{children}</SessionModelContext.Provider>;
}

export function useSessionModel(): SessionModel {
  const model = useContext(SessionModelContext);
  if (!model) throw new Error('useSessionModel 必须在 SessionModelProvider 内使用。');
  return model;
}
