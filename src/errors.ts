/** A problem the user can fix (bad path, unknown adapter, …): the CLI prints
 *  `error: <message>` without a stack and exits with `code`. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
