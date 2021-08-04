
import { COMPLETE_MAP_UPDATE, UPDATE_MAP_DATA, REQUEST_TILE, TOGGLE_EXISTING_ROADS } from '../actions';

const initial = {
  tempStore: null,
  requestedTiles: new Set(),
  showExistingRoads: false
};

const map = (state = initial, action) => {
  switch (action.type) {
    case COMPLETE_MAP_UPDATE:
      return Object.assign({}, state, { tempStore: null });
    case UPDATE_MAP_DATA:
      return Object.assign({}, state, { tempStore: action.data });
    case TOGGLE_EXISTING_ROADS:
      return Object.assign({}, state, { showExistingRoads: !state.showExistingRoads });
    case REQUEST_TILE:
      return Object.assign({}, state, {
        requestedTiles: new Set(state.requestedTiles).add(action.data, true)
      });
    default:
      return state;
  }
};

export default map;