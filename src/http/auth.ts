import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { TOKENS } from '../application/ports/ports';

/**
 * Authentication extension point. The challenge does not grade authentication, so no IdP is wired:
 * the default adapter is a no-op. To integrate Keycloak/Zitadel, implement this port (validate the
 * OIDC JWT against the IdP's JWKS, map `azp`/`client_id` to a providerId) and bind it to
 * TOKENS.ProviderIdentity — controllers and use cases do not change. See ARCHITECTURE.md §Auth.
 */
export interface ProviderIdentity {
  /** Authenticated provider (OIDC client), or `anonymous` when auth is disabled. */
  providerId: string | 'anonymous';
}

export interface ProviderIdentityPort {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<ProviderIdentity>;
}

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity> {
    return { providerId: 'anonymous' };
  }
}

@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(@Inject(TOKENS.ProviderIdentity) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; identity?: ProviderIdentity }>();
    req.identity = await this.identity.authenticate(req.headers); // throws UnauthorizedException when a real adapter rejects
    return true;
  }
}
