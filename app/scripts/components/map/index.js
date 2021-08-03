
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
    const limits = { min_zoom: zoom, max_zoom: zoom };
    const feature = bboxPolygon(bounds[0].concat(bounds[1]));
    const cover = tiles(feature.geometry, limits);

    // if we have one tile to cover the area, return it, otherwise try at one
    // zoom level up
    return (cover.length === 1)
    ? cover[0]
    : this.getCoverTile(bounds, zoom - 1);
  },

  loadMapData: function (mapEvent) {
    if (!mapEvent.target.getBounds || this.props.draw.mode === INACTIVE) return;
    const coverTile = this.getCoverTile(
      mapEvent.target.getBounds().toArray(),
      Math.floor(mapEvent.target.getZoom())
    );

    // only fetch new data if we haven't requested this tile before
    if (!this.props.map.requestedTiles.has(coverTile.join('/'))) {
      this.props.dispatch(fetchMapData(coverTile));
    }
  },

  markAsEdited: function (feature) {
    console.log('marking as edited');
    if (feature.properties.status !== EDITED) {
      feature.properties.status = EDITED;
      this.draw.add(feature);
    }
  },

  splitLine: function (e) {
    const { draw } = this;
    const ids = draw.getFeatureIdsAt(e.point);
    if (!ids.length) { return; }
    const line = draw.get(ids[0]);
    const cursorAt = point([e.lngLat.lng, e.lngLat.lat]);

    // delete the existing line, and add two additional lines.
    draw.delete(line.id);
    const newIds = [];
    newIds.push(draw.add(lineSlice(point(firstCoord(line)), cursorAt, line)));
    newIds.push(draw.add(lineSlice(cursorAt, point(lastCoord(line)), line)));

    this.splitMode({ featureIds: newIds });
    const newLines = newIds.map(id => draw.get(id));

    // Mark the new lines as edited
    newLines.forEach(this.markAsEdited);
    const actions = newLines.map(createRedo).concat(createUndo(line));
    this.props.dispatch(updateSelection(actions));
  },

  joinLines: function (e) {
    const { draw, props } = this;

    const cursor = point([e.lngLat.lng, e.lngLat.lat]);
    const featureIds = draw.getFeatureIdsAt(e.point);

    // a length of 2 means we're hovering over a feature
    if (featureIds.length > 1) {
      // the first item in the array seems to always be the one the user is continuing from
      const fromLineString = draw.get(featureIds[0]);
      const originalFromLineString = fromLineString;
      const toLineString = draw.get(featureIds[1]);
      const mergedLineString = { type: 'Feature', properties: { status: EDITED } };
      let nearest;
      let minDist;

      coordEach(toLineString, function (coord, i) {
        var dist = distance(cursor, point(coord));

        if (!minDist || dist < minDist) {
          nearest = toLineString.geometry.coordinates[i];
          minDist = dist;
        }
      });

      // add point to front or back of fromLineString dependending on distance
      // TODO: is there a way to get something like "most recent point i've continued from"
      const fromFront = fromLineString.geometry.coordinates[0];
      const fromBack = fromLineString.geometry.coordinates[fromLineString.geometry.coordinates.length - 1];
      const frontDistance = distance(fromFront, nearest);
      const backDistance = distance(fromBack, nearest);

      if (frontDistance > backDistance) {
        fromLineString.geometry.coordinates.push(nearest);
      } else {
        fromLineString.geometry.coordinates.unshift(nearest);
      }

      // merge the two lines together
      mergedLineString.geometry = dissolve([fromLineString.geometry, toLineString.geometry]);

      // delete old lines
      draw.delete(fromLineString.id);
      draw.delete(toLineString.id);

      // add new merged line
      const newId = draw.add(mergedLineString);
      const newLine = draw.get(newId);

      var actions = [
        createUndo(originalFromLineString),
        createUndo(toLineString),
        createRedo(newLine)
      ];

      props.dispatch(changeDrawMode(null));
      draw.changeMode('simple_select');
      props.dispatch(updateSelection(actions));
    }
  },

  setLineStatus: function (e) {
    const { value } = e.currentTarget;
    if (value === MULTIPLE) return;
    const ids = this.state.selected.map(d => d.id);
    // set the new completion status
    ids.forEach(id => this.draw.setFeatureProperty(id, 'status', value));
    // re-query the features and add to history
    const updatedFeatures = ids.map(id => this.draw.get(id));
    this.handleUpdate(updatedFeatures);
  },

  toggleVisibility: function (status) {
    this.props.dispatch(toggleVisibility(status));
  },

  toggleExistingRoads: function () {
    this.props.dispatch(toggleExistingRoads());
  },

  delete: function () {
    // override draw functionality for specific case:
    // line selected, no point selected, in direct_select mode
    const mode = this.draw.getMode();
    const selected = this.draw.getSelected().features;
    const selectedPoints = this.draw.getSelectedPoints().features;
    if (mode === 'direct_select' && selected.length && !selectedPoints.length) {
      this.draw.delete(selected.map(f => f.id));
      this.handleDelete(selected);
      this.setState({ selected: [] });
    } else {
      // use native draw delete, event handlers handle the rest
      this.draw.trash();
    }
  },

  render: function () {
    if (!App.glSupport) { return noGl; }
    const { save } = this.props;
    const { past, future } = this.props.selection;
    const isSynced = !past.length || save.historyId === past[past.length - 1].historyId;
    const selectedFeatures = this.state.selected;
    const statuses = uniq(selectedFeatures.map(d => d.properties.status || INCOMPLETE));
    const status = !statuses.length ? null
      : statuses.length > 1 ? MULTIPLE : statuses[0];
    const hidden = this.props.draw.hidden;
    const uiDisabled = this.props.draw.mode === INACTIVE;
    const showExistingRoads = this.props.map.showExistingRoads;

    return (
      <div className='map__container' ref={this.initMap} id={id}>
        {uiDisabled ? (
          <div className='menubar menubar--disabled'>
            <div className='row'>
              <button className='button button-base' onClick={() => this.map.zoomTo(minTileZoom)}>Zoom to edit</button>
            </div>
          </div>
        ) : (
          <div className='menubar'>
            <div className='row'>
              <ul>
                <li className={c({ disabled: !selectedFeatures.length })}>
                  <label>Line Status</label>
                  <div className={c('select-wrapper')}>
                    <select value={status || ''} onChange={this.setLineStatus}>
                      {!selectedFeatures.length && <option value=''></option>}
                      {status === MULTIPLE && <option value={MULTIPLE}>Multiple</option>}
                      <option value={INCOMPLETE}>Incomplete</option>
                      <option value={EDITED}>In Progress</option>
                      <option value={COMPLETE}>Complete</option>
                    </select>
                  </div>
                </li>
                <li>
                  <button className={c({disabled: !past.length}, 'button button-undo button--outline')} onClick={this.undo}>Undo{this.help('bottom', 'ctrl+z')}</button>
                  <button className={c({disabled: !future.length}, 'button button-redo button--outline')} onClick={this.redo}>Redo{this.help('bottom', 'ctrl+shift+z')}</button>
                </li>
                <li>
                  <button className={c({disabled: isSynced}, 'button button-base')} onClick={this.save}>SAVE CHANGES{this.help('bottom', 'ctrl+s')}</button>
                  {save.inflight ? <span style={{float: 'right'}}>Saving...</span> : null}
                  {save.success ? <span style={{float: 'right'}}>Success!</span> : null}
                </li>
              </ul>
            </div>
          </div>
        )}

        <div className='tool-bar'>
          {uiDisabled ? <span /> : (
            <fieldset className='tools'>
              <legend>Tools</legend>
              <ul>
                <li className='tool--line tool__item' onClick={this.newLineMode}>
                  <a href="#">
                    <img alt='Add Line' src='../graphics/layout/icon-line.svg' />
                  </a>
                  {this.help('top', 'd')}
                </li>
                <li
                  className={c('tool--line-add tool__item',
                  { disabled: !this.draw || (this.draw && !this.isLineContinuationValid() && this.props.draw.mode !== CONTINUE) },
                  { active: this.props.draw.mode === CONTINUE }
                  )}
                  onClick={this.lineContinuationMode}
                  >
                  <a href="#">
                    <img alt='Add Point' src='../graphics/layout/icon-addline.svg' />
                  </a>
                  {this.help('top', 'c')}
                </li>
                <li className={c('tool--cut tool__item', {active: this.props.draw.mode === SPLIT})}>
                  <a onClick={this.splitMode} href="#">
                    <img alt='Split Line' src='../graphics/layout/icon-cut.svg' />
                  </a>
                  {this.help('bottom', 's')}
                </li>
                <li className='tool--trash tool__item' onClick={this.delete}>
                  <a href="#">
                    <img alt='delete' src='../graphics/layout/icon-trash.svg' />
                  </a>
                  {this.help('bottom', 'del')}
                </li>
              </ul>
            </fieldset>
          )}

          {uiDisabled ? <span /> : (
            <fieldset className='toggle'>
              <legend>Predicted Road Layers</legend>
              <ul>
                <li className='toggle__item toggle__all'>
                  <a className={c({showall: hidden.length >= 1})} href="#" onClick={this.toggleVisibility.bind(this, 'all')}>
                    <icon className='visibility'><span>Hide/Show</span></icon>
                    <span className='line-description'>All Predicted</span>
                  </a>
                </li>
                <li className='toggle__item'>
                  <a className={c({showall: hidden.indexOf(INCOMPLETE) > -1})} href="#" onClick={this.toggleVisibility.bind(this, INCOMPLETE)}>
                    <icon className='visibility'><span>Hide/Show</span></icon>
                    <span className='line__item line--incomplete line-description'>Incomplete</span>
                  </a>
                </li>
                <li className='toggle__item'>
                  <a className={c({showall: hidden.indexOf(EDITED) > -1})} href="#" onClick={this.toggleVisibility.bind(this, EDITED)}>
                    <icon className='visibility'><span>Hide/Show</span></icon>
                    <span className='line-description line__item line--progress'>In Progress</span>
                  </a>
                </li>
                <li className='toggle__item'>
                  <a className={c({showall: hidden.indexOf(COMPLETE) > -1})} href="#" onClick={this.toggleVisibility.bind(this, COMPLETE)}>
                    <icon className='visibility'><span>Hide/Show</span></icon>
                    <span className='line-description line__item line--complete'>Complete</span>
                  </a>
                </li>
              </ul>
            </fieldset>
          )}

          <fieldset className='toggle'>
            <legend>Existing Road Network Layers</legend>
            <ul>
              <li className='toggle__item'>
                <a className={c({showall: showExistingRoads})} href="#" onClick={this.toggleExistingRoads}>
                  <icon className='visibility'><span>Hide/Show</span></icon>
                  <span className='line__item line--existing line-description'>Existing roads</span>
                </a>
              </li>
            </ul>
          </fieldset>
        </div>
      </div>
    );
  },

  help: function (position, text) {
    if (!this.state.showHelp) return null;
    const outerClass = 'help help__' + position;
    return (
      <div className={outerClass}>
        <div className='help__in'>
          {text}
        </div>
      </div>
    );
  },

  propTypes: {
    dispatch: React.PropTypes.func,
    selection: React.PropTypes.object,
    map: React.PropTypes.object,
    draw: React.PropTypes.object,
    save: React.PropTypes.object
  }
});

function createUndo (f) {
  return { id: f.id, undo: f, redo: null };
}

function createRedo (f) {
  return { id: f.id, undo: null, redo: f };
}

function mapStateToProps (state) {
  return {
    selection: state.selection,
    map: state.map,
    draw: state.draw,
    save: state.save
  };
}

export default connect(mapStateToProps)(Map);