'use strict';

const handler = require('../../api/check-contribution-status');

exports.handler = async function (event) {
  const headers = event.headers || {};
  const request = {
    method: event.httpMethod,
    headers: headers,
    query: event.queryStringParameters || {},
    body: event.body
  };
  const response = createResponse();
  await handler(request, response);
  return response.result();
};

function createResponse() {
  let statusCode = 200;
  const headers = {};
  let body = {};

  return {
    setHeader: function (name, value) { headers[name] = value; },
    status: function (code) { statusCode = code; return this; },
    json: function (value) { body = value; return this; },
    result: function () {
      return {
        statusCode: statusCode,
        headers: headers,
        body: JSON.stringify(body)
      };
    }
  };
}