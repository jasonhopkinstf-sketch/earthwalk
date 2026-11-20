// Who is allowed in, and what they are called.
//
// This is the seam for connecting a people system (planned: Maijel). Today every
// visitor is a guest identified by the name they type; a future directory can map
// an invite token to a known person, their display name and who they may meet.

export interface Hello { name: string; room: string; token?: string }
export interface Person { personId: string | null; displayName: string }

export interface PeopleDirectory {
  /** Returns the person for a join request, or null to refuse entry. */
  identify(hello: Hello): Promise<Person | null>;
}

/** Guests only, optionally gated by one shared access code. */
export class GuestDirectory implements PeopleDirectory {
  private readonly accessCode: string;
  constructor(accessCode = "") {
    this.accessCode = accessCode;
  }
  async identify(hello: Hello): Promise<Person | null> {
    if (this.accessCode && hello.token !== this.accessCode) return null;
    return { personId: null, displayName: hello.name };
  }
}
