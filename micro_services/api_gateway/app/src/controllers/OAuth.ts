import { FastifyRequest, FastifyReply } from 'fastify'
import db from '../classes/Databases'
import AuthProvider from '../classes/AuthProvider'
import { SignInStatesModel, UserModel } from '../types/DbTables'
import { OAuthCodeExchangeResponse, OAuthResponse } from '../types/OAuth'
import rabbitmq from '../classes/RabbitMQ'
import { RabbitMQRequest, RabbitMQUserManagerOp } from '../types/RabbitMQMessages'

async function OAuthExchangeCode(code: string): Promise<OAuthResponse> {
    const reqOpt: RequestInit = {
        method: 'POST',
        headers: {
            'host': 'oauth2.googleapis.com',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            'code': code,
            'client_id': process.env.GOOGLE_CLIENT_ID || '',
            'client_secret': process.env.GOOGLE_CLIENT_SECRET || '',
            'redirect_uri': process.env.GOOGLE_REDIRECT_URL || '',
            'grant_type': 'authorization_code'
        })
    };
    const response = await fetch('https://oauth2.googleapis.com/token', reqOpt);
    if (!response.ok)
        throw 'OAuthExchangeCode(): Response from google auth provider is not ok.';
    var responsejson = await response.json() as OAuthCodeExchangeResponse;
    var result: OAuthResponse = {} as OAuthResponse;
    result.response = responsejson;
    result.jwt = AuthProvider.ValidateJWT(responsejson.id_token);
    return result;
}

function SignUpNewUser(OAuthRes: OAuthResponse, reply: FastifyReply) {
    db.CreateNewUser(OAuthRes);
    const msg: RabbitMQRequest = {
        op: RabbitMQUserManagerOp.CREATE,
        id: '',
        JWT: OAuthRes.jwt
    }
    rabbitmq.sendToUserManagerQueue(msg, reply, OAuthRes.response.id_token);
}

function FetchUser(OAuthRes: OAuthResponse, reply: FastifyReply) {
    const msg: RabbitMQRequest = {
        op: RabbitMQUserManagerOp.FETCH,
        message: OAuthRes.jwt.sub,
        id: '',
        JWT: OAuthRes.jwt
    }
    rabbitmq.sendToUserManagerQueue(msg, reply, OAuthRes.response.id_token);
}

export const AuthenticateUser = async (request: FastifyRequest<{
    Querystring: {
        state: string,
        code: string,
        scope: string
    }
}>, reply: FastifyReply) => {
    try {
        if (!AuthProvider.isReady)
            throw `OAuth class not ready`;
        const { state, code } = request.query;
        const getStateQuery = db.transient.prepare('SELECT * FROM signin_states WHERE state = ?;');
        const getStateResult = getStateQuery.get(state) as SignInStatesModel;
        if (getStateResult === undefined)
            throw `Invalid state_code=${state}`;
        const runquery = db.transient.prepare('DELETE FROM signin_states WHERE state = ?;');
        const runResult = runquery.run(state);
        if (runResult.changes !== 1)
            throw `did not remove state_code=${state} from the db.`;
        var OAuthRes = await OAuthExchangeCode(code);
        const getUserQuery = db.persistent.prepare('SELECT * FROM users WHERE UID = ?;');
        const getUserResult = getUserQuery.get(OAuthRes.jwt.sub) as UserModel;
        reply.hijack();
        if (getUserResult === undefined)
            SignUpNewUser(OAuthRes, reply);
        else
            FetchUser(OAuthRes, reply);
        return Promise.resolve();
    } catch (error) {
        console.log(`ERROR: AuthenticateUser(): ${error}`);
        return reply.code(500).send(`ERROR: Invalid credentials.`);
    }
}

export const GetOAuthCode = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        if (!AuthProvider.isReady)
            throw `OAuth class not ready`;
        const randomValues = new Uint32Array(4);
        crypto.getRandomValues(randomValues);
        // Encode as UTF-8
        const utf8Encoder = new TextEncoder();
        const utf8Array = utf8Encoder.encode(
            String.fromCharCode.apply(null, Array.from(randomValues))
        );
        // Base64 encode the UTF-8 data
        var code = btoa(String.fromCharCode.apply(null, Array.from(utf8Array)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        const created = Date.now() / 1000;
        const query = db.transient.prepare('INSERT INTO signin_states ( state , created ) VALUES( ? , ? );');
        const res = query.run(code, created);
        if (res.changes !== 1)
            throw `did not add state code to db`;
        return reply.code(200).send(code);
    } catch (error) {
        console.log(`ERROR: GetOAuthCode(): ${error}`);
        return reply.code(500).send("ERROR: internal error, try again later.");
    }
}
