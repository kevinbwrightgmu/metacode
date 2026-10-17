// Modules used by the type-checked server code that ship without types.
// Express is used through its documented API; its request and response
// objects are treated as untyped here (route handlers validate their inputs).
declare module 'express' {
  const express: any;
  export = express;
}
