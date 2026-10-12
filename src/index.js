'use strict';

const { run } = require('./action');
const { fail } = require('./runtime');

run().catch(error => fail(error.message));
