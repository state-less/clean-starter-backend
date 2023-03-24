import { render, StateValue } from '@state-less/react-server';

import { globalInstance } from '@state-less/react-server/dist/lib/reactServer';

import { Resolver, State } from '@state-less/react-server/dist/types/graphql';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import jwksClient from 'jwks-rsa';
import { pubsub, store } from './instances';
import TimestampType from './lib/TimestampType';
import { JWT_SECRET } from './config';

enum AuthStrategy {
    Google = 'google',
}

type PartialAuth<T> = {
    id: string;
    email?: string;
    token: string;
    decoded: T;
};

type CompoundAuth = PartialAuth<unknown> & {
    strategy;
    strategies: Record<AuthStrategy, PartialAuth<unknown>>;
};

type GoogleAuthData = {
    accessToken: string;
    idToken: string;
};

type GoogleToken = {
    iss: string;
    sub: string;
    email: string;
};
const authenticateGoogle = async ({
    accessToken,
    idToken,
}: GoogleAuthData): Promise<PartialAuth<GoogleToken>> => {
    try {
        await verifyGoogleSignature(accessToken);
    } catch (e) {
        console.log('Error verifying signature', e.message);
        throw e;
    }
    const decoded = await decodeGoogleToken(idToken);

    return {
        id: decoded.sub,
        email: decoded.email,
        token: idToken,
        decoded,
    };
};

const generatePubSubKey = (state: Pick<State, 'key' | 'scope'>) => {
    return `${state.key}:${state.scope}`;
};

const generateComponentPubSubKey = (state: Pick<State, 'key' | 'scope'>) => {
    return `component::${state.key}`;
};

const useState: Resolver<unknown, State & { initialValue: StateValue }> = (
    parent,
    args
) => {
    const { initialValue, key, scope } = args;
    const state = store.getState(initialValue, { key, scope });

    return {
        ...state,
    };
};

const renderComponent: Resolver<unknown, State> = (parent, args, context) => {
    const { key, scope, props } = args;
    const component = globalInstance.components.get(key);
    if (!component) {
        throw new Error('Component not found');
    }

    try {
        const rendered = render(component, { clientProps: props, context });
        return {
            rendered,
        };
    } catch (e) {
        console.log('Error rendering component', e, context);
        return {
            rendered: {
                error: e.message,
            },
        };
    }
};

const setState: Resolver<unknown, State> = (parent, args) => {
    const { scope, value, key } = args;
    const state = store.getState(null, { key, scope });
    state.value = value;

    pubsub.publish(generatePubSubKey(state), { updateState: state });

    return {
        ...state,
    };
};

const callFunction = async (parent, args, context) => {
    const { key, scope, prop, args: fnArgs } = args;
    const component = globalInstance.components.get(key);
    const rendered = render(component, context);
    if (rendered.props[prop]) {
        const { fn } = rendered.props[prop];
        const result = fn(...fnArgs);
        return result;
    }

    return {
        rendered,
    };
};

const verifyGoogleSignature = async (token: string) => {
    console.log(
        'Verifying google signature',
        `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`
    );
    try {
        const response = await axios.get(
            `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`
        );

        if (response.data.error) {
            throw new Error(response.data.error);
        }

        return response.data;
    } catch (e) {
        throw new Error(
            `Error verifying google signature: ${e.message || e.toString()}`
        );
    }
};

const strategies: Record<AuthStrategy, (data: any) => Promise<PartialAuth>> = {
    [AuthStrategy.Google]: authenticateGoogle,
};

const decodeGoogleToken = async (token): Promise<GoogleToken> => {
    return new Promise((resolve, reject) => {
        const client = jwksClient({
            jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        });

        // Find the key that matches the key ID in the JWT token header
        jwt.verify(
            token,
            (header, callback) => {
                client.getSigningKey(header.kid, (err, key: any) => {
                    const signingKey = key.publicKey || key.rsaPublicKey;
                    callback(null, signingKey);
                });
            },
            {},
            (err, decoded) => {
                if (err) {
                    reject(err);
                }
                resolve(decoded as GoogleToken);
            }
        );
    });
};

type AuthStrategyData = {
    [AuthStrategy.Google]: GoogleAuthData;
};

const authenticate = async <T extends AuthStrategy>(
    parent,
    args: { strategy: T; data: AuthStrategyData[T] },
    context
): Promise<CompoundAuth> => {
    const { strategy, data } = args;

    if (!strategies[strategy]) {
        throw new Error('Invalid strategy');
    }

    const auth = await strategies[strategy](data);

    if (!isValidAuthResponse(auth)) {
        throw new Error('Invalid auth response');
    }

    const id = `${strategy}:${auth.id}`;
    const payload = {
        id,
        strategy,
        strategies: {
            [strategy as AuthStrategy]: auth,
        },
    };

    return {
        ...payload,
        token: jwt.sign(payload, JWT_SECRET),
    };
};

const isValidAuthResponse = (auth: any): auth is PartialAuth => {
    return auth && auth.id && auth.token;
};

export const resolvers = {
    Query: {
        getState: useState,
        renderComponent,
    },
    Mutation: {
        setState,
        callFunction,
        authenticate,
    },
    Subscription: {
        updateState: {
            subscribe: (parent, args: Pick<State, 'key' | 'scope'>) => {
                return pubsub.asyncIterator(generatePubSubKey(args));
            },
        },
        updateComponent: {
            subscribe: (parent, args: Pick<State, 'key' | 'scope'>) => {
                console.log(
                    'Subscribing to component',
                    generateComponentPubSubKey(args)
                );
                return pubsub.asyncIterator(generateComponentPubSubKey(args));
            },
        },
    },
    Components: {
        // eslint-disable-next-line no-underscore-dangle
        __resolveType(obj) {
            // eslint-disable-next-line no-underscore-dangle
            return obj.__typename || null;
        },
    },
    Timestamp: TimestampType,
};
