/* Copyright (C) 2018-2020 The Manyverse Authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import xs, {Stream} from 'xstream';
import flattenConcurrently from 'xstream/extra/flattenConcurrently';
import xsFromPullStream from 'xstream-from-pull-stream';
import {Reducer} from '@cycle/state';
import {AsyncStorageSource} from 'cycle-native-asyncstorage';
import {FeedId, MsgId} from 'ssb-typescript';
import {ThreadAndExtras, MsgAndExtras} from '../../ssb/types';
import {SSBSource, GetReadable} from '../../drivers/ssb';
import {Props} from './props';

export type State = {
  selfFeedId: FeedId;
  selfAvatarUrl?: string;
  rootMsgId: MsgId;
  higherRootMsgId: MsgId | undefined;
  loading: boolean;
  loadingReplies: boolean;
  thread: ThreadAndExtras;
  subthreads: Record<MsgId, ThreadAndExtras>;
  expandRootCW: boolean;
  replyText: string;
  replyEditable: boolean;
  getSelfRepliesReadable: GetReadable<MsgAndExtras> | null;
  startedAsReply: boolean;
  keyboardVisible: boolean;
};

export type Actions = {
  publishMsg$: Stream<any>;
  willReply$: Stream<any>;
  loadReplyDraft$: Stream<MsgId>;
  replySeen$: Stream<MsgId>;
  keyboardAppeared$: Stream<any>;
  keyboardDisappeared$: Stream<any>;
  updateReplyText$: Stream<string>;
};

const emptyThread: ThreadAndExtras = {full: true, messages: []};
const missingThread: ThreadAndExtras = {
  full: true,
  messages: [],
  errorReason: 'missing',
};
const blockedThread: ThreadAndExtras = {
  full: true,
  messages: [],
  errorReason: 'blocked',
};
const unknownErrorThread: ThreadAndExtras = {
  full: true,
  messages: [],
  errorReason: 'unknown',
};

export default function model(
  props$: Stream<Props>,
  actions: Actions,
  asyncStorageSource: AsyncStorageSource,
  ssbSource: SSBSource,
): Stream<Reducer<State>> {
  const propsReducer$ = props$.take(1).map(
    props =>
      function propsReducer(_prev?: State): State {
        return {
          selfFeedId: props.selfFeedId,
          selfAvatarUrl: props.selfAvatarUrl,
          rootMsgId: props.rootMsgId ?? props.rootMsg.key,
          higherRootMsgId: props.higherRootMsgId,
          loading: true,
          loadingReplies: !!props.rootMsg,
          thread: emptyThread,
          subthreads: {},
          expandRootCW: props.expandRootCW ?? false,
          replyText: '',
          replyEditable: true,
          getSelfRepliesReadable: null,
          startedAsReply: props.replyToMsgId ? true : false,
          keyboardVisible: props.replyToMsgId ? true : false,
        };
      },
  );

  const setRootMsgReducer$ = props$
    .take(1)
    .map(props =>
      props.rootMsg ? ssbSource.rehydrateMessage$(props.rootMsg) : xs.never(),
    )
    .flatten()
    .map(
      rootMsg =>
        function setRootMsgReducer(prev: State): State {
          if (prev.thread.full && prev.thread.messages.length > 0) {
            return prev;
          } else {
            return {...prev, thread: {full: false, messages: [rootMsg]}};
          }
        },
    );

  const setThreadReducer$ = props$
    .take(1)
    .map(props =>
      ssbSource
        .thread$(props.rootMsgId ?? props.rootMsg.key, false)
        .replaceError(err => {
          if (/Author Blocked/i.test(err.message)) return xs.of(blockedThread);
          if (/Not Found/i.test(err.message)) return xs.of(missingThread);
          else return xs.of(unknownErrorThread);
        }),
    )
    .flatten()
    .map(
      thread =>
        function setThreadReducer(prev: State): State {
          return {...prev, thread, loading: false, loadingReplies: false};
        },
    );

  const setSubthreadReducer$ = actions.replySeen$
    .map(msgId =>
      ssbSource
        .thread$(msgId, false)
        .replaceError(_err => xs.of(emptyThread))
        .map(
          subthread =>
            function setSubthreadReducer(prev: State): State {
              if (prev.subthreads[msgId]) {
                return prev;
              } else {
                return {
                  ...prev,
                  subthreads: {...prev.subthreads, [msgId]: subthread},
                };
              }
            },
        ),
    )
    .compose(flattenConcurrently);

  const keyboardAppearedReducer$ = actions.keyboardAppeared$.mapTo(
    function keyboardAppearedReducer(prev: State): State {
      return {...prev, keyboardVisible: true};
    },
  );

  const keyboardDisappearedReducer$ = actions.keyboardDisappeared$.mapTo(
    function keyboardDisappearedReducer(prev: State): State {
      return {...prev, keyboardVisible: false};
    },
  );

  const updateReplyTextReducer$ = actions.updateReplyText$.map(
    text =>
      function updateReplyTextReducer(prev: State): State {
        return {...prev, replyText: text};
      },
  );

  const publishReplyReducers$ = actions.publishMsg$
    .map(() =>
      xs.of(
        function emptyPublishedReducer(prev: State): State {
          return {...prev, replyText: '', replyEditable: false};
        },
        function resetEditableReducer(prev: State): State {
          return {...prev, replyEditable: true};
        },
      ),
    )
    .flatten();

  const emptyReplyTextReducer$ = actions.willReply$.mapTo(
    function emptyReplyTextReducer(prev: State): State {
      return {...prev, replyText: ''};
    },
  );

  const loadReplyDraftReducer$ = actions.loadReplyDraft$
    .map(rootMsgId => asyncStorageSource.getItem(`replyDraft:${rootMsgId}`))
    .flatten()
    .map(
      replyText =>
        function loadReplyDraftReducer(prev: State): State {
          if (!replyText) {
            return {...prev, replyText: ''};
          } else {
            return {...prev, replyText};
          }
        },
    );

  const addSelfRepliesReducer$ = actions.willReply$
    .map(() =>
      ssbSource.selfReplies$
        .map(getReadable =>
          xsFromPullStream<MsgAndExtras>(
            getReadable({live: true, old: false}),
          ).take(1),
        )
        .flatten(),
    )
    .flatten()
    .map(
      newMsg =>
        function addSelfRepliesReducer(prev: State): State {
          return {
            ...prev,
            thread: {
              messages: prev.thread.messages.concat([newMsg]),
              full: true,
            },
          };
        },
    );

  return xs.merge(
    propsReducer$,
    setRootMsgReducer$,
    setThreadReducer$,
    setSubthreadReducer$,
    keyboardAppearedReducer$,
    keyboardDisappearedReducer$,
    updateReplyTextReducer$,
    publishReplyReducers$,
    emptyReplyTextReducer$,
    loadReplyDraftReducer$,
    addSelfRepliesReducer$,
  );
}
