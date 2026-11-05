/**
 * SSE 剧本生成器：产出与 DeepSeek 线上接口同形态的 data: 事件序列。
 *
 * 事件形态来自对原脚本（script.js）与线上 bundle 行为的分析：
 *   {"p":"response","o":"SET","v":{...}}
 *   {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[...]}, ...]}
 */
'use strict';

function ev(obj) {
  return 'data: ' + JSON.stringify(obj);
}

/* ------------------------------------------------------------------ */
/* 1. 正常完整回答（无撤回）                                            */
/* ------------------------------------------------------------------ */
function normal() {
  return [
    'event: message',
    ev({ p: '', o: 'SET', v: { response: { message_id: 11, fragments: [] } } }),
    ev({ p: 'response/message_id', o: 'SET', v: 11 }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'THINKING', content: '用户在问天气。' }] }
      ]
    }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 3, type: 'ANSWER', content: '今天多云，' }] }
      ]
    }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 4, type: 'ANSWER', content: '气温 18-25 度。' }] }
      ]
    }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }),
    ''
  ];
}

/* ------------------------------------------------------------------ */
/* 2. 生成中段被撤回（BATCH + fragments TEMPLATE_RESPONSE）              */
/*    服务端把整段 fragments 覆盖成模板占位，并置 CONTENT_FILTER          */
/* ------------------------------------------------------------------ */
function recallDuringGenerate() {
  return [
    'event: message',
    ev({ p: '', o: 'SET', v: { response: { message_id: 21, fragments: [] } } }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'THINKING', content: '这段思考' }] }
      ]
    }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 3, type: 'ANSWER', content: '要输出的正文第一段' }] }
      ]
    }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 4, type: 'ANSWER', content: '以及第二段内容' }] }
      ]
    }),
    // ★ 撤回信号
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
        { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }
      ]
    }),
    ''
  ];
}

/* ------------------------------------------------------------------ */
/* 3. 思考阶段被 CONTENT_FILTER                                         */
/*    只有 status 被改，fragments 保留                                  */
/* ------------------------------------------------------------------ */
function filterDuringThinking() {
  return [
    'event: message',
    ev({ p: '', o: 'SET', v: { response: { message_id: 31, fragments: [] } } }),
    ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'THINKING', content: '正在推理…' }] }
      ]
    }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ];
}

/* ------------------------------------------------------------------ */
/* 历史接口：含 CONTENT_FILTER 的消息                                    */
/* ------------------------------------------------------------------ */
function historyWithFilter(msgId, frags) {
  return JSON.stringify({
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: {
        chat_session: { id: 'sess-abc', title: '测试会话' },
        chat_messages: [
          {
            message_id: msgId,
            status: 'CONTENT_FILTER',
            fragments: frags || [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }]
          },
          {
            message_id: msgId + 1,
            status: 'FINISHED',
            fragments: [{ id: 3, type: 'ANSWER', content: '这条正常。' }]
          }
        ]
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 分页接口形态（结构另起一层）                                          */
/* ------------------------------------------------------------------ */
function fetchPageWithFilter(msgId) {
  return JSON.stringify({
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { id: 'sess-abc', title: '测试会话' },
        chat_messages: [
          { message_id: msgId, status: 'CONTENT_FILTER', fragments: [] }
        ]
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 6. 长对话：N 个事件，用于验证增量解析不 O(n²)                          */
/* ------------------------------------------------------------------ */
function longConversation(eventCount, chunkSize) {
  eventCount = eventCount || 220;
  chunkSize = chunkSize || 2000;
  var out = [
    'event: message',
    ev({ p: '', o: 'SET', v: { response: { message_id: 41, fragments: [] } } })
  ];
  var big = new Array(chunkSize + 1).join('x');
  for (var i = 0; i < eventCount; i++) {
    out.push(ev({
      p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ id: 2 + i, type: 'ANSWER', content: big }] }
      ]
    }));
  }
  out.push(ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }));
  out.push('');
  return out;
}

function longConversationWithRecall(eventCount, chunkSize) {
  var lines = longConversation(eventCount, chunkSize);
  // 把最后一个 status 行换成撤回信号
  var idx = lines.length - 2;
  lines[idx] = ev({
    p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }
    ]
  });
  return lines;
}

module.exports = {
  ev: ev,
  normal: normal,
  recallDuringGenerate: recallDuringGenerate,
  filterDuringThinking: filterDuringThinking,
  historyWithFilter: historyWithFilter,
  fetchPageWithFilter: fetchPageWithFilter,
  longConversation: longConversation,
  longConversationWithRecall: longConversationWithRecall
};
