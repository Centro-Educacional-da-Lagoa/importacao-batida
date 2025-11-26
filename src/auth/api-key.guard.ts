import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.headers['x-api-key'];

    if (!process.env.API_KEY) {
      console.error('API_KEY not set in environment variables');
      throw new UnauthorizedException('API Key authentication is not configured.');
    }

    if (apiKey === process.env.API_KEY) {
      return true;
    } else {
      throw new UnauthorizedException('Invalid or missing API Key.');
    }
  }
}
