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
const doc = jsdom.jsdom('<!doctype html><html><