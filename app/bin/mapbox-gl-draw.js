(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.MapboxDraw = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var runSetup = require('./src/setup');
var setupOptions = require('./src/options');
var setupAPI = require('./src/api');
var Constants = require('./src/constants');

var setupDraw = function setupDraw(options, api) {
  options = setupOptions(options);

  var ctx = {
    options: options
  };

  api = setupAPI(ctx, api);
  ctx.api = api;

  var setup = runSetup(ctx);

  api.onAdd = setup.onAdd;
  api.onRemove = setup.onRemove;
  api.types = Constants.types;
  api.options = options;

  return api;
};

module.exports = function (options) {
  setupDraw(options, this);
};

},{"./src/api":25,"./src/constants":26,"./src/options":61,"./src/setup":63}],2:[function(require,module,exports){
var wgs84 = require('wgs84');

module.exports.geometry = geometry;
module.exports.ring = ringArea;

function geometry(_) {
    var area = 0, i;
    switch (_.type) {
        case 'Polygon':
            return polygonArea(_.coordinates);
        case 'MultiPolygon':
            for (i = 0; i < _.coordinates.length; i++) {
                area += polygonArea(_.coordinates[i]);
            }
            return area;
        case 'Point':
        case 'MultiPoint':
        case 'LineString':
        case 'MultiLineString':
            return 0;
        case 'GeometryCollection':
            for (i = 0; i < _.geometries.length; i++) {
                area += geometry(_.geometries[i]);
            }
            return area;
    }
}

function polygonArea(coords) {
    var area = 0;
    if (coords && coords.length > 0) {
        area += Math.abs(ringArea(coords[0]));
        for (var i = 1; i < coords.length; i++) {
            area -= Math.abs(ringArea(coords[i]));
        }
    }
    return area;
}

/**
 * Calculate the approximate area of the polygon were it projected onto
 *     the earth.  Note that this area will be positive if ring is oriented
 *     clockwise, otherwise it will be negative.
 *
 * Reference:
 * Robert. G. Chamberlain and William H. Duquette, "Some Algorithms for
 *     Polygons on a Sphere", JPL Publication 07-03, Jet Propulsion
 *     Laboratory, Pasadena, CA, June 2007 http://trs-new.jpl.nasa.gov/dspace/handle/2014/40409
 *
 * Returns:
 * {float} The approximate signed geodesic area of the polygon in square
 *     meters.
 */

function ringArea(coords) {
    var p1, p2, p3, lowerIndex, middleIndex, upperIndex, i,
    area = 0,
    coordsLength = coords.length;

    if (coordsLength > 2) {
        for (i = 0; i < coordsLength; i++) {
            if (i === coordsLength - 2) {// i = N-2
                lowerIndex = coordsLength - 2;
                middleIndex = coordsLength -1;
                upperIndex = 0;
            } else if (i === coordsLength - 1) {// i = N-1
                lowerIndex = coordsLength - 1;
                middleIndex = 0;
                upperIndex = 1;
            } else { // i = 0 to N-3
                lowerIndex = i;
                middleIndex = i+1;
                upperIndex = i+2;
            }
            p1 = coords[lowerIndex];
            p2 = coords[middleIndex];
            p3 = coords[upperIndex];
            area += ( rad(p3[0]) - rad(p1[0]) ) * Math.sin( rad(p2[1]));
        }

        area = area * wgs84.RADIUS * wgs84.RADIUS / 2;
    }

    return area;
}

function rad(_) {
    return _ * Math.PI / 180;
}
},{"wgs84":23}],3:[function(require,module,exports){
module.exports = normalize;

var types = {
    Point: 'geometry',
    MultiPoint: 'geometry',
    LineString: 'geometry',
    MultiLineString: 'geometry',
    Polygon: 'geometry',
    MultiPolygon: 'geometry',
    GeometryCollection: 'geometry',
    Feature: 'feature',
    FeatureCollection: 'featurecollection'
};

/**
 * Normalize a GeoJSON feature into a FeatureCollection.
 *
 * @param {object} gj geojson data
 * @returns {object} normalized geojson data
 */
function normalize(gj) {
    if (!gj || !gj.type) return null;
    var type = types[gj.type];
    if (!type) return null;

    if (type === 'geometry') {
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {},
                geometry: gj
            }]
        };
    } else if (type === 'feature') {
        return {
            type: 'FeatureCollection',
            features: [gj]
        };
    } else if (type === 'featurecollection') {
        return gj;
    }
}

},{}],4:[function(require,module,exports){
var jsonlint = require('jsonlint-lines'),
  geojsonHintObject = require('./object');

/**
 * @alias geojsonhint
 * @param {(string|object)} GeoJSON given as a string or as an object
 * @param {Object} options
 * @param {boolean} [options.noDuplicateMembers=true] forbid repeated
 * properties. This is only available for string input, becaused parsed
 * Objects cannot have duplicate properties.
 * @param {boolean} [options.precisionWarning=true] warn if GeoJSON contains
 * unnecessary coordinate precision.
 * @returns {Array<Object>} an array of errors
 */
function hint(str, options) {

    var gj, errors = [];

    if (typeof str === 'object') {
        gj = str;
    } else if (typeof str === 'string') {
        try {
            gj = jsonlint.parse(str);
        } catch(e) {
            var match = e.message.match(/line (\d+)/);
            var lineNumber = parseInt(match[1], 10);
            return [{
                line: lineNumber - 1,
                message: e.message,
                error: e
            }];
        }
    } else {
        return [{
            message: 'Expected string or object as input',
            line: 0
        }];
    }

    errors = errors.concat(geojsonHintObject.hint(gj, options));

    return errors;
}

module.exports.hint = hint;

},{"./object":5,"jsonlint-lines":15}],5:[function(require,module,exports){
var rightHandRule = require('./rhr');

/**
 * @alias geojsonhint
 * @param {(string|object)} GeoJSON given as a string or as an object
 * @param {Object} options
 * @param {boolean} [options.noDuplicateMembers=true] forbid repeated
 * properties. This is only available for string input, becaused parsed
 * Objects cannot have duplicate properties.
 * @param {boolean} [options.precisionWarning=true] warn if GeoJSON contains
 * unnecessary coordinate precision.
 * @returns {Array<Object>} an array of errors
 */
function hint(gj, options) {

    var errors = [];
    var precisionWarningCount = 0;
    var maxPrecisionWarnings = 10;
    var maxPrecision = 6;

    function root(_) {

        if ((!options || options.noDuplicateMembers !== false) &&
           _.__duplicateProperties__) {
            errors.push({
                message: 'An object contained duplicate members, making parsing ambigous: ' + _.__duplicateProperties__.join(', '),
                line: _.__line__
            });
        }

        if (requiredProperty(_, 'type', 'string')) {
            return;
        }

        if (!types[_.type]) {
            var expectedType = typesLower[_.type.toLowerCase()];
            if (expectedType !== undefined) {
                errors.push({
                    message: 'Expected ' + expectedType + ' but got ' + _.type + ' (case sensitive)',
                    line: _.__line__
                });
            } else {
                errors.push({
                    message: 'The type ' + _.type + ' is unknown',
                    line: _.__line__
                });
            }
        } else if (_) {
            types[_.type](_);
        }
    }

    function everyIs(_, type) {
        // make a single exception because typeof null === 'object'
        return _.every(function(x) {
            return x !== null && typeof x === type;
        });
    }

    function requiredProperty(_, name, type) {
        if (typeof _[name] === 'undefined') {
            return errors.push({
                message: '"' + name + '" member required',
                line: _.__line__
            });
        } else if (type === 'array') {
            if (!Array.isArray(_[name])) {
                return errors.push({
                    message: '"' + name +
                        '" member should be an array, but is an ' +
                        (typeof _[name]) + ' instead',
                    line: _.__line__
                });
            }
        } else if (type === 'object' && _[name] && _[name].constructor.name !== 'Object') {
            return errors.push({
                message: '"' + name +
                    '" member should be ' + (type) +
                    ', but is an ' + (_[name].constructor.name) + ' instead',
                line: _.__line__
            });
        } else if (type && typeof _[name] !== type) {
            return errors.push({
                message: '"' + name +
                    '" member should be ' + (type) +
                    ', but is an ' + (typeof _[name]) + ' instead',
                line: _.__line__
            });
        }
    }

    // https://tools.ietf.org/html/rfc7946#section-3.3
    function FeatureCollection(featureCollection) {
        crs(featureCollection);
        bbox(featureCollection);
        if (featureCollection.properties !== undefined) {
            errors.push({
                message: 'FeatureCollection object cannot contain a "properties" member',
                line: featureCollection.__line__
            });
        }
        if (featureCollection.coordinates !== undefined) {
            errors.push({
                message: 'FeatureCollection object cannot contain a "coordinates" member',
                line: featureCollection.__line__
            });
        }
        if (!requiredProperty(featureCollection, 'features', 'array')) {
            if (!everyIs(featureCollection.features, 'object')) {
                return errors.push({
                    message: 'Every feature must be an object',
                    line: featureCollection.__line__
                });
            }
            featureCollection.features.forEach(Feature);
        }
    }

    // https://tools.ietf.org/html/rfc7946#section-3.1.1
    function position(_, line) {
        if (!Array.isArray(_)) {
            return errors.push({
                message: 'position should be an array, is a ' + (typeof _) +
                    ' instead',
                line: _.__line__ || line
            });
        }
        if (_.length < 2) {
            return errors.push({
                message: 'position must have 2 or more elements',
                line: _.__line__ || line
            });
        }
        if (_.length > 3) {
            return errors.push({
                message: 'position should not have more than 3 elements',
                level: 'message',
                line: _.__line__ || line
            });
        }
        if (!everyIs(_, 'number')) {
            return errors.push({
                message: 'each element in a position must be a number',
                line: _.__line__ || line
            });
        }

        if (options && options.precisionWarning) {
            if (precisionWarningCount === maxPrecisionWarnings) {
                precisionWarningCount += 1;
                return errors.push({
                    message: 'truncated war