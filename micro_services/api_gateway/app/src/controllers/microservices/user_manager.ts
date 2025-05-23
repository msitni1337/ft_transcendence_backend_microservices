import { FastifyReply, FastifyRequest } from "fastify";
import {
  RabbitMQRequest,
  RabbitMQUserManagerOp,
  UpdateUser,
} from "../../types/RabbitMQMessages";
import rabbitmq from "../../classes/RabbitMQ";
import fs from "fs";
import { multipart_fields, multipart_files } from "../../types/multipart";
import db from "../../classes/Databases";
import { UserModel, users_table_name } from "../../types/DbTables";
import crypto from "crypto";

export const SearchByUsername = async (
  request: FastifyRequest<{ Querystring: { username: string } }>,
  reply: FastifyReply
) => {
  if (!request.query.username)
    return reply.code(400).send("bad request");
  try {
    reply.header("Content-Type", "application/json");
    const query = db.persistent.prepare(
      `SELECT username FROM '${users_table_name}' WHERE username LIKE ? ;`
    );
    const res = query.all(`%${request.query.username}%`);
    reply.code(200).send(res);
  } catch (error) {
    reply.code(400).send("bad request");
  }
}

const DecorateUserInfo = (UID: string, response_message: string, request: FastifyRequest, reply: FastifyReply) => {
  try {
    let payload = JSON.parse(response_message);
    const query = db.persistent.prepare(
      `SELECT username, totp_enabled FROM '${users_table_name}' WHERE UID = ? ;`
    );
    const res = query.get(UID) as UserModel;
    if (!res)
      throw "database error";
    payload.username = res.username;
    if (UID === request.jwt.sub)
      payload.totp_enabled = res.totp_enabled;
    reply.raw.end(reply.serialize(payload));
  } catch (error) {
    console.log(`[ERROR] DecorateUserInfo(): ${error}`);
    reply.raw.statusCode = 400;
    reply.raw.end('bad request');
  }
}

export const FetchUserInfo = async (
  request: FastifyRequest<{ Querystring: { uid: string; username: string } }>,
  reply: FastifyReply
) => {
  try {
    const { uid, username } = request.query;
    if (!uid && !username) return reply.code(400).send("bad request");
    let UID: string = "";
    if (uid) {
      if (uid === "me") UID = request.jwt.sub;
      else UID = uid;
    } else if (username) {
      try {
        const query = db.persistent.prepare(
          `SELECT UID FROM '${users_table_name}' WHERE username = ? ;`
        );
        const res = query.get(username) as UserModel;
        if (!res) throw "no user found";
        UID = res.UID;
      } catch (err) {
        return reply.code(404).send("user not found");
      }
    }
    const RabbitMQReq: RabbitMQRequest = {
      op: RabbitMQUserManagerOp.FETCH,
      message: UID,
      id: "",
      JWT: request.jwt,
    };
    reply.hijack();
    rabbitmq.sendToQueue(rabbitmq.user_manager_queue, RabbitMQReq, (response) => {
      reply.raw.statusCode = response.status;
      if (response.status !== 200 || response.message === undefined)
        return reply.raw.end(response.message);
      DecorateUserInfo(UID, response.message, request, reply);
    });
  } catch (error) {
    console.log(`ERROR: FetchUserInfo(): ${error}`);
    reply.raw.statusCode = 400;
    reply.raw.end('bad request');
  }
  return Promise.resolve();
};

export const UpdateUserInfo = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  if (!request.is_valid_multipart) return reply.code(400).send("bad request");
  try {
    const UpdatedInfo: UpdateUser = {
      bio: null,
      picture_url: null,
    };
    const username: multipart_fields | undefined = request.fields.find(
      (field: multipart_fields, i) => field.field_name === "username"
    );
    const bio: multipart_fields | undefined = request.fields.find(
      (field: multipart_fields, i) => field.field_name === "bio"
    );
    const image: multipart_files | undefined = request.files_uploaded.find(
      (file: multipart_files) => file.field_name === "picture"
    );
    if (!username && !bio && !image) return reply.code(400).send("bad request");
    if (image) {
      if (image.mime_type !== "image/jpeg")
        return reply.code(400).send(`only image jpeg are allowed`);
      UpdatedInfo.picture_url = `/static/profile/${request.jwt.sub}.jpg`;
      fs.writeFileSync(UpdatedInfo.picture_url, image.field_file.read());
    }
    if (bio) {
      UpdatedInfo.bio = bio.field_value;
    }
    if (username) {
      if (username.field_value.length < 3)
        return reply.code(400).send("bad request provide a valid username");
      try {
        const query = db.persistent.prepare(
          `UPDATE '${users_table_name}' SET username = ? WHERE UID = ? ;`
        );
        const res = query.run(
          username.field_value,
          request.jwt.sub
        );
        if (res.changes !== 1) throw "UpdateUserInfo(): database error";
      } catch (error) {
        console.log(`ERROR: UpdateUserInfo(): query.run(): ${error}`);
        return reply.code(400).send("username is taken");
      }
    }
    if (
      UpdatedInfo.bio === null &&
      UpdatedInfo.picture_url === null
    )
      return reply.code(200).send('username updated');
    reply.hijack();
    const RabbitMQReq: RabbitMQRequest = {
      op: RabbitMQUserManagerOp.UPDATE,
      message: JSON.stringify(UpdatedInfo),
      id: "",
      JWT: request.jwt,
    };
    rabbitmq.sendToQueue(rabbitmq.user_manager_queue, RabbitMQReq, (response) => {
      reply.raw.statusCode = response.status;
      reply.raw.end(response.message);
    });
  } catch (error) {
    console.log(`ERROR: UpdateUserInfo(): ${error}`);
    reply.raw.statusCode = 400;
    reply.raw.end('bad request');
  }
  return Promise.resolve();
};

export const UpdateUserPassword = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  if (!request.is_valid_multipart) return reply.code(400).send("bad request");
  try {
    const new_password: multipart_fields | undefined = request.fields.find(
      (field: multipart_fields, i) => field.field_name === "new_password"
    );
    {
      if (!new_password || new_password.field_value.length < 8)
        return reply.code(400).send("provide valid credentials > 7 chars");
      const query = db.persistent.prepare(
        `SELECT password_hash FROM '${users_table_name}' WHERE UID = ? ;`
      );
      const result = query.get(request.jwt.sub) as UserModel;
      if (result && result.password_hash && result.password_hash !== null) {
        const old_password: multipart_fields | undefined = request.fields.find(
          (field: multipart_fields, i) => field.field_name === "old_password"
        );
        if (!old_password || old_password.field_value.length < 8)
          return reply.code(400).send("provide valid credentials > 7 chars");
        const hasher = crypto.createHash("sha256");
        hasher.update(Buffer.from(old_password.field_value));
        if (hasher.digest().toString() !== result.password_hash)
          return reply.code(400).send("invalid old password");
      }
    }
    const hasher = crypto.createHash("sha256");
    hasher.update(Buffer.from(new_password.field_value));
    const query = db.persistent.prepare(
      `UPDATE '${users_table_name}' SET password_hash = ? WHERE UID = ? ;`
    );
    const result = query.run(hasher.digest().toString(), request.jwt.sub);
    if (result.changes !== 1) throw "database error";
    return reply.code(200).send("password updated");
  } catch (error) {
    console.log(`ERROR: UpdateUserPassword(): ${error}`);
    reply.code(400).send('bad request');
  }
};

export const RemoveUserProfile = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  try {
    const UpdatedInfo: UpdateUser = {
      bio: null,
      picture_url: process.env.DEFAULT_PROFILE_PATH as string,
    };
    const picture_path = `/static/profile/${request.jwt.sub}.jpg`;
    if (!fs.existsSync(picture_path))
      return reply.status(400).send("Picture already removed.");
    reply.hijack();
    const RabbitMQReq: RabbitMQRequest = {
      op: RabbitMQUserManagerOp.UPDATE,
      message: JSON.stringify(UpdatedInfo),
      id: "",
      JWT: request.jwt,
    };
    rabbitmq.sendToQueue(rabbitmq.user_manager_queue, RabbitMQReq, (response) => {
      if (response.status === 200) {
        fs.unlinkSync(picture_path);
      }
      reply.raw.statusCode = response.status;
      reply.raw.end(response.message);
    });
  } catch (error) {
    console.log(`[ERROR] RemoveUserProfile(): ${error}`);
    reply.raw.statusCode = 400;
    reply.raw.end("bad request.");
  }
  return Promise.resolve();
};
