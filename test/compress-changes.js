'use strict';
import test from 'tape';
import compress, { compressChanges } from '../app/scripts/util/compress-changes';

test('compression', function (t) {
  // modification, then deletion
  let payload = compress([
    {selection: [{id: 1, redo: 1, undo: 1}]},
    {selection: [{id: 1, redo: 1, undo: 1}]},
    {selection: [{id: 1, redo: 1, undo: 1}]},
    {selection: [{id: 1, redo: 1, undo: 1}]},
    {selection: [{id: 1, redo: 1, undo: 1}]},
    {selection: [{id: 1, redo: 1, undo: 1}]},
    {selection: [{id: 1, redo: 0, undo: 1}]}
  ]);
  t.equal(payload.deleted.length, 1);
  t.equal(