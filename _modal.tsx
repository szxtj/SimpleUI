import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsModal } from './src/components/SettingsModal';
const settings: any = { apiPort: 1235, modelId: 'gemma-4-26b-a4b-it', maxContext: 16384,
  enableThinking: true, reasoningEffort: 'high', temperature: 0, topP: 0.95, topK: 64,
  repetitionPenalty: 1.0, maxTokens: 4096, stopStrings: [], systemPrompt: 'x', language: 'zh', theme: 'dark' };
const html = renderToStaticMarkup(React.createElement(SettingsModal,
  { isOpen: true, onClose: () => {}, settings, onSave: () => {} } as any));
console.log('  渲染成功，输出 ' + html.length + ' 字符');
console.log('  三张卡片标题都在: ' + (['应用设置','知识库 (ZIM)','模型设置'].every(k => html.includes(k)) ? '✅' : '❌'));
console.log('  模型卡在知识库卡之后: ' + (html.indexOf('模型设置') > html.indexOf('知识库 (ZIM)') ? '✅' : '❌'));
console.log('  应用卡在最前: ' + (html.indexOf('应用设置') < html.indexOf('知识库 (ZIM)') ? '✅' : '❌'));
