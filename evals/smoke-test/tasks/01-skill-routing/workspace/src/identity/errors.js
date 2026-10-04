export class AuthRefreshError extends Error {constructor(message='refresh failed',{cause}={}){super(message,{cause});this.name='AuthRefreshError';this.code='AUTH_REFRESH_FAILED';}}
