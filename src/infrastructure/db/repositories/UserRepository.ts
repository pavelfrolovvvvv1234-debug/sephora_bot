/**
 * User repository for database operations.
 *
 * @module infrastructure/db/repositories/UserRepository
 */

import { DataSource } from "typeorm";
import User, { Role, UserStatus } from "../../../entities/User";
import { BaseRepository } from "./base";
import { NotFoundError } from "../../../shared/errors/index";

/**
 * User repository with user-specific operations.
 */
export class UserRepository extends BaseRepository<User> {
  constructor(dataSource: DataSource) {
    super(dataSource, User);
  }

  /**
   * Find user by Telegram ID.
   */
  async findByTelegramId(telegramId: number): Promise<User | null> {
    return this.repository.findOne({
      where: { telegramId },
    });
  }

  /**
   * Find or create user by Telegram ID.
   */
  async findOrCreateByTelegramId(telegramId: number): Promise<User> {
    let user = await this.findByTelegramId(telegramId);

    if (!user) {
      user = new User();
      user.telegramId = telegramId;
      user.status = UserStatus.User;
      user = await this.save(user);
    }

    return user;
  }

  /**
   * Update user balance atomically (with transaction support).
   */
  async updateBalance(
    userId: number,
    amount: number,
    transaction?: DataSource
  ): Promise<User> {
    const repo = transaction ? transaction.getRepository(User) : this.repository;
    const user = await repo.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundError("User", userId);
    }

    user.balance += amount;
    return repo.save(user);
  }

  /**
   * Check if user has sufficient balance.
   */
  async hasSufficientBalance(userId: number, amount: number): Promise<boolean> {
    const user = await this.findById(userId);
    if (!user) return false;
    return user.balance >= amount;
  }

  /**
   * Get user balance.
   */
  async getBalance(userId: number): Promise<number> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }
    return user.balance;
  }

  /**
   * Update user language.
   */
  async updateLanguage(userId: number, lang: "ru" | "en"): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }
    user.lang = lang;
    return this.save(user);
  }

  /**
   * Update user role.
   */
  async updateRole(userId: number, role: Role): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }
    user.role = role;
    return this.save(user);
  }

  /**
   * Ban/unban user.
   */
  async setBanned(userId: number, isBanned: boolean): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }
    user.isBanned = isBanned;
    return this.save(user);
  }

  /**
   * Find users by role.
   */
  async findByRole(role: Role): Promise<User[]> {
    return this.repository.find({
      where: { role },
    });
  }

  /**
   * Update user status.
   */
  async updateStatus(userId: number, status: UserStatus): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }
    user.status = status;
    return this.save(user);
  }
}
