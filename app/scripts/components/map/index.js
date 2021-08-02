
'use strict';
import React from 'react';
import { connect } from 'react-redux';
import c from 'classnames';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import bboxPolygon from 'turf-bbox-polygon';
import distance from 'turf-distance';
import { coordEach } from '@turf/meta';
import { point } from '@turf/helpers';
import lineSlice from '@turf/line-slice';
import dissolve from 'geojson-linestring-dissolve';
import { tiles } from 'tile-cover';
import uniq from 'lodash.uniq';
import { firstCoord, lastCoord } from '../../util/line';
import { environment, existingRoadsSource, minTileZoom, initialZoom } from '../../config';
import App from '../../util/app';
import mapboxgl from 'mapbox-gl';

import drawStyles from './styles/mapbox-draw-styles';
const lineLayers = drawStyles.filter(style => style.type === 'line');

import {
  updateSelection, undo, redo, completeUndo, completeRedo, save, fetchMapData,
  completeMapUpdate, changeDrawMode, toggleVisibility, toggleExistingRoads
} from '../../actions';

import { SPLIT, COMPLETE, INCOMPLETE, EDITED, MULTIPLE, CONTINUE, INACTIVE } from './utils/constants';

// don't add any segment twice
const added = new Set();

const noGl = (
  <div className='nogl'>
    <p>Sorry, but your browser does not support GL.</p>
  </div>
);
const id = 'main-map-component';
export const Map = React.createClass({
  getInitialState: () => ({
    selected: [],
    showHelp: false
  }),

  initMap: function (el) {
    if (el && !this.map && App.glSupport) {
      mapboxgl.accessToken = 'pk.eyJ1IjoibWFwZWd5cHQiLCJhIjoiY2l6ZTk5YTNxMjV3czMzdGU5ZXNhNzdraSJ9.HPI_4OulrnpD8qI57P12tg';
      this.map = App.map = new mapboxgl.Map({
        center: [105.66, 20],
        container: el,
        style: 'mapbox://styles/mapbox/satellite-v9',
        zoom: initialZoom
      });
      const nav = new mapboxgl.NavigationControl();
      this.map.addControl(nav, 'bottom-right');
      const draw = new MapboxDraw({
        styles: drawStyles,
        displayControlsDefault: false,
        userProperties: true
      });
      this.map.addControl(draw);
      this.draw = draw;
      // TODO: review whether the create and delete listeners fire anywhere now
      // that we're calling some events programatically
      this.map.on('draw.create', (e) => this.handleCreate(e.features));
      this.map.on('draw.delete', (e) => this.handleDelete(e.features));
      this.map.on('draw.update', (e) => {
        this.handleUpdate(e.features);
        e.features.forEach(this.markAsEdited);
      });
      this.map.on('draw.selectionchange', (e) => {
        // internal state used to track "previous state" of edited geometry
        this.setState({selected: e.features});
        // skip directly to direct_select if a feature is selected
        const mode = draw.getMode();
        if (e.features.length === 1 && mode === 'simple_select') {
          draw.changeMode('direct_select', { featureId: e.features[0].id });
        }
      });

      this.map.on('load', (e) => {
        this.map.addSource('grid', {
          type: 'vector',
          url: 'mapbox://openroads.d9d310da'
        });
        this.map.addLayer({
          id: '1km-grid',
          source: 'grid',
          type: 'line',
          paint: {
            'line-color': '#E8E8E8',
            'line-width': 2,
            'line-opacity': 0.3,
            'line-dasharray': [4, 2]
          },
          'source-layer': '1kmgrid'
        });
        this.map.addSource('network', {
          type: 'vector',
          tiles: [existingRoadsSource]
        });
        this.map.addLayer({
          id: 'network',
          source: 'network',
          type: 'line',
          paint: {
            'line-color': '#3B9FFF',
            'line-width': 2
          },
          'source-layer': 'network'
        }, 'gl-draw-line-inactive.cold');

        this.loadMapData(e);
      });
      this.map.on('moveend', (e) => {
        this.loadMapData(e);
      });
      this.map.on('zoomend', (e) => {
        const zoom = e.target.getZoom();
        if (zoom >= minTileZoom && this.props.draw.mode === INACTIVE) {
          this.props.dispatch(changeDrawMode(null));
        } else if (zoom < minTileZoom && this.props.draw.mode !== INACTIVE) {
          this.props.dispatch(changeDrawMode(INACTIVE));
        }
      });
      this.map.on('click', (e) => {
        switch (this.props.draw.mode) {
          case SPLIT: this.splitLine(e); break;
          case CONTINUE: this.joinLines(e); break;
        }
      });
      // development-only logs for when draw switches modes
      if (environment === 'development') {
        this.map.on('draw.modechange', (e) => {
          console.log('mode', e.mode);
        });
      }
    }
  },

  isLineContinuationValid: function () {
    const lineString = this.draw.getSelected().features[0];
    const selectedPoint = this.draw.getSelectedPoints().features[0];
    const mode = this.draw.getMode();
    return mode === 'direct_select' && lineString && selectedPoint;
  },

  lineContinuationMode: function () {
    const lineString = this.draw.getSelected().features[0];
    const selectedPoint = this.draw.getSelectedPoints().features[0];
    if (selectedPoint) {
      this.props.dispatch(changeDrawMode(CONTINUE));
      this.draw.changeMode('draw_line_string', { featureId: lineString.id, from: selectedPoint });
    }
  },

  newLineMode: function () {
    this.draw.changeMode('draw_line_string');
  },

  splitMode: function (options) {
    options = options || {};
    if (this.props.draw.mode === SPLIT) {
      this.props.dispatch(changeDrawMode(null));
      this.draw.changeMode('simple_select', options);
    } else {
      this.props.dispatch(changeDrawMode(SPLIT));
      this.draw.changeMode('static');
    }
  },

  componentWillMount: function () {
    document.addEventListener('keydown', this.handleShortcuts);
  },

  componentWillUnmount: function () {
    document.removeEventListener('keydown', this.handleShortcuts);
    this.map = App.map = this.draw = null;
  },

  componentWillReceiveProps: function (nextProps) {
    // if we have a selection, update our map accordingly
    const { selection, historyId } = nextProps.selection.present;
    if (selection.length) {
      selection.forEach(f => {
        this.featureUpdate(f, historyId);
      });
      this.props.dispatch(historyId === 'undo' ? completeUndo() : completeRedo());
      const ids = selection.map(d => d.id);
      // Hack to ensure Draw renders the correct color
      this.draw.changeMode('simple_select', { featureIds: ids });
      this.draw.changeMode('simple_select', { featureIds: [] });
    }

    // if we have a tempStore, update the Draw.store with it then clear
    if (nextProps.map.tempStore) {
      nextProps.map.tempStore.forEach(feature => {
        // only add, no deletes or updates
        if (!added.has(feature.properties.id)) {
          const toAdd = Object.assign({}, feature, { id: feature.properties.id });
          if (!toAdd.properties.hasOwnProperty('status')) {
            toAdd.properties.status = 'incomplete';
          }
          added.add(feature.properties.id);
          this.draw.add(toAdd);
        }
      });
      this.props.dispatch(completeMapUpdate());
    }

    // existing roads visibility
    if (nextProps.map.showExistingRoads) {
      this.map.setLayoutProperty('network', 'visibility', 'none');
    } else {
      this.map.setLayoutProperty('network', 'visibility', 'visible');
    }

    // line visibility
    // const hiddenLines = nextProps.draw.hidden;
    lineLayers.forEach(layer => {
      const coldLayer = `${layer.id}.cold`;
      const hotLayer = `${layer.id}.hot`;
      if (this.map.getLayer(coldLayer)) {
        const baseFilter = lineLayers.find(l => l.id === layer.id).filter;
        this.map.setFilter(coldLayer, [...baseFilter, ['!in', 'user_status'].concat(nextProps.draw.hidden)]);
      }
      if (this.map.getLayer(hotLayer)) {
        const baseFilter = lineLayers.find(l => l.id === layer.id).filter;
        this.map.setFilter(hotLayer, [...baseFilter, ['!in', 'user_status'].concat(nextProps.draw.hidden)]);
      }
    });

    // toggle predictions layers when map mode changes from inactive to anything else
    if ((nextProps.draw.mode === INACTIVE || this.props.draw.mode === INACTIVE) &&
        nextProps.draw.mode !== this.props.draw.mode) {
      this.toggleVisibility('all');
      this.draw.changeMode('simple_select', { featureIds: [] });
    }
  },

  featureUpdate: function (feature, undoOrRedoKey) {
    // if we have a geo, replace/add
    if (feature[undoOrRedoKey]) {
      this.draw.add(feature[undoOrRedoKey]);
    } else {
      // otherwise delete
      this.draw.delete(feature.id);
    }
  },

  handleShortcuts: function (e) {
    const { past, future } = this.props.selection;
    const { ctrlKey, metaKey, shiftKey, keyCode } = e;
    // meta key can take the place of ctrl on osx
    const ctrl = ctrlKey || metaKey;
    let isShortcut = true;

    switch (keyCode) {
      // z
      case (90):
        if (shiftKey && ctrl && future.length) this.redo();
        else if (!shiftKey && ctrl && past.length) this.undo();
        break;

      // s
      case (83):
        if (ctrl) this.save();
        else this.splitMode();
        break;

      // e
      case (69):
        this.expandMode();
        break;

      // c
      case (67):
        this.lineContinuationMode();
        break;

      // d
      case (68):
        this.newLineMode();
        break;

      // space bar
      case (32):
        this.setState({ showHelp: !this.state.showHelp });
        break;

      // del & backspace
      case (8):
      case (46):
        this.delete();
        break;

      default:
        isShortcut = false;
    }
    // only prevent default if we hit a real shortcut
    if (isShortcut) { e.preventDefault(); }
  },

  handleDelete: function (features) {
    this.props.dispatch(updateSelection(features.map(createUndo)));
  },

  handleCreate: function (features) {
    features.forEach(this.markAsEdited);
    // reset draw mode in case we were in CONTINUE; remove this after line
    // continuation doesn't fire a create event
    const zoom = this.map.getZoom();
    if (zoom < minTileZoom) {
      this.props.dispatch(changeDrawMode(INACTIVE));
    } else {
      this.props.dispatch(changeDrawMode(null));
    }
    this.props.dispatch(updateSelection(features.map(createRedo)));
  },

  handleUpdate: function (features) {
    this.props.dispatch(updateSelection(features.map(f => {
      const oldFeature = this.state.selected.find(a => a.id === f.id);
      return { id: f.id, undo: oldFeature, redo: f };
    })));
    // reset draw mode in case we were in CONTINUE
    this.props.dispatch(changeDrawMode(null));
    this.setState({selected: this.draw.getSelected().features});
  },

  undo: function () {
    this.props.dispatch(undo());
  },

  redo: function () {
    this.props.dispatch(redo());
  },

  save: function () {
    const { past } = this.props.selection;
    const { historyId } = this.props.save;
    this.props.dispatch(save(past, historyId));
  },

  getCoverTile: function (bounds, zoom) {