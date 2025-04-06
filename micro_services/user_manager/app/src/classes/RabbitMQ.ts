import amqp from 'amqplib'
import { Options } from 'amqplib'
import { RabbitMQRequest, RabbitMQResponse, RabbitMQUserManagerOp } from '../types/RabbitMQMessages';
import db from './Databases';


class RabbitMQ {
    isReady = false;
    connection_option: Options.Connect =
        {
            hostname: process.env.RABBITMQ_HOST,
            port: (process.env.RABBITMQ_PORT || 5577) as number,
            username: process.env.RABBITMQ_USER || '',
            password: process.env.RABBITMQ_PASSWORD || '',
        };
    connection: amqp.ChannelModel;
    channel: amqp.Channel;
    api_gateway_queue = process.env.RABBITMQ_API_GATEWAY_QUEUE_NAME || 'ft_api_gateway';
    user_manager_queue = process.env.RABBITMQ_USER_MANAGER_QUEUE_NAME || 'ft_user_manager';
    constructor() {
        this.connection = {} as amqp.ChannelModel;
        this.channel = {} as amqp.Channel;
    }
    public init() {
        this.AttemptConnection();
    }
    async AttemptConnection() {
        try {
            this.isReady = false;
            console.log('RabbitMQ establishing connection.');
            this.connection = await amqp.connect(this.connection_option);
            this.channel = await this.connection.createChannel();
            await this.channel.assertQueue(this.api_gateway_queue, { durable: false });
            await this.channel.assertQueue(this.user_manager_queue, { durable: false });
            await this.channel.consume(this.user_manager_queue, this.consumeUserManagerQueue, { noAck: true });
            this.channel.on('close', async () => { await new Promise(r => setTimeout(r, 1000)); this.AttemptConnection(); });
            this.isReady = true;
            console.log('RabbitMQ class connection established.');
        } catch (error) {
            console.log(`Error: rabbitmq AttemptConnection(): ${error}`);
            await new Promise(r => setTimeout(r, 1000));
            this.AttemptConnection();
        }
    }
    consumeUserManagerQueue(msg: amqp.ConsumeMessage | null) {
        if (!msg)
            return;
        var RMqResponse: RabbitMQResponse = {
            status: 500,
            req_id: '',
            message: ''
        };
        try {
            const RMqRequest = JSON.parse(msg.content.toString()) as RabbitMQRequest;
            RMqResponse.req_id = RMqRequest.id;
            switch (RMqRequest.op) {
                case RabbitMQUserManagerOp.CREATE:
                    RMqResponse.message = JSON.stringify(db.CreateNewUser(RMqRequest.JWT));
                    RMqResponse.status = 200;
                    break;
                case RabbitMQUserManagerOp.FETCH:
                    RMqResponse.message = JSON.stringify(db.FetchUser(RMqRequest.message as string));
                    RMqResponse.status = 200;
                    break;
                default:
                    console.log("WARNING: rabbitmq consumeUserManagerQueue(): operation not implemented.");
                    RMqResponse.message = 'operation not implemented'
                    break;
            }
        } catch (error) {
            console.log(`Error: rabbitmq consumeUserManagerQueue(): ${error}`);
            if (RMqResponse.req_id === '') // Ignoring unparsed request cause req_id not resolvable
                return;
            RMqResponse.message = 'internal server error: try later.';
        }
        rabbitmq.sendToAPIGatewayQueue(RMqResponse);
    }
    public sendToAPIGatewayQueue(RMqResponse: RabbitMQResponse) {
        if (!this.isReady)
            throw 'RabbitMQ class not ready';
        this.channel.sendToQueue(this.api_gateway_queue, Buffer.from(JSON.stringify(RMqResponse)));
    }
}

const rabbitmq = new RabbitMQ();

export default rabbitmq;

