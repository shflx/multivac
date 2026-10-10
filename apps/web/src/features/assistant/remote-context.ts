import { createContext, useContext } from 'react';

/** 只描述浏览器入口身份，不参与模型工具权限判断。 */
export const RemoteConversationContext = createContext(false);
export function useRemoteConversation(): boolean { return useContext(RemoteConversationContext); }
