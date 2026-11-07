export class ErreurHttp extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const echec = (status, message, code) => {
  throw new ErreurHttp(status, message, code);
};
