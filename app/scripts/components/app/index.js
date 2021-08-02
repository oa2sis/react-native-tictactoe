'use strict';
import React from 'react';
import { connect } from 'react-redux';

import Header from './header';
import Footer from './footer';

var App = React.createClass({
  displayName: 'App',

  propTypes: {
    children: React.PropTypes.object
  },

  render: function () {
    return (
      <div className='app'>
        <Header />
        <main className='main' role='main'>
          {this.props.children}
        </main>
        <Footer />
      </div>
    );
  }
});

export default connect(state => state)(App);
