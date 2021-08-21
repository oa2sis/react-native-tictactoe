/* eslint-disable no-unused-vars */
import React from 'react';
import test from 'tape';
import mock from 'mapbox-gl-js-mock';
import proxyquire from 'proxyquire';
import { mount } from 'enzyme';
import App from '../app/scripts/util/app';
App.glSupport = true;

// stub global DOM methods
import jsdom from 'jsdom';
const doc = jsdom.jsdom('<!doctype html><html><body></body></html>');
global.window = doc.defaultView;
global.document = doc;

// stub mapbox draw
const draw = () => true;
draw.prototype.add = () => true;
draw.prototype.onAdd = () => true;
draw.prototype.getSelected = () => ({ features: [{ properties: {} }] });
draw.prototype.getSelectedPoints = () => ({ features: [{ properties: {} }] });
draw.prototype.getMode = () => 'simple_select';
draw.prototype.changeMode = () => true;

const { Map } = proxyquire.noCallThru().load('../app/scripts/components/map', {
  '@mapbox/mapbox-gl-draw': draw,
  'mapbox-gl': mock,
  '../../util/app': App
});

function setup (options) {
  options = options || {};
  const props = Object.assign({
    selection: {
      past: [],
      present: { historyId: 'initial' },
      future: []
    },
    map: {
     